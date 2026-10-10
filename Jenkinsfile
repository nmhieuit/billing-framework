#!/usr/bin/env groovy

// CI cho billing-framework. Agent cần: POSIX shell, Node 22 với corepack, Docker daemon
// (tầng integration về sau dùng testcontainers), và sonar-scanner trong PATH.
pipeline {
    agent any

    parameters {
        string(name: 'SONARQUBE_SERVER', defaultValue: 'sonarqube',
               description: 'Tên SonarQube server đã cấu hình trong Jenkins (phải khớp nền tảng dùng chung)')
        string(name: 'PACT_BROKER_BASE_URL', defaultValue: '',
               description: 'Địa chỉ Pact Broker dùng chung; để trống thì bỏ qua các bước publish/verify/can-i-deploy')
        string(name: 'PACT_BROKER_CREDENTIALS_ID', defaultValue: 'pact-broker',
               description: 'Credential Jenkins (username/password) của Pact Broker')
        booleanParam(name: 'PACT_ENFORCE_CAN_I_DEPLOY', defaultValue: false,
                     description: 'Bật khi ecommerce đã verify pact: can-i-deploy "no" sẽ làm hỏng build thay vì chỉ cảnh báo')
    }

    options {
        timeout(time: 30, unit: 'MINUTES')
        timestamps()
        disableConcurrentBuilds(abortPrevious: true)
    }

    stages {
        stage('Install') {
            steps {
                sh 'corepack enable'
                sh 'corepack pnpm install --frozen-lockfile'
            }
        }

        stage('Static checks') {
            steps {
                sh 'corepack pnpm lint'
                sh 'corepack pnpm typecheck'
                sh 'corepack pnpm format:check'
            }
        }

        stage('Test') {
            steps {
                sh 'corepack pnpm test:coverage'
            }
        }

        stage('Integration tests') {
            steps {
                // Cần Docker daemon: testcontainers khởi động SQL Server 2022.
                sh 'corepack pnpm test:integration'
            }
        }

        stage('Contract tests (Pact)') {
            when { expression { params.PACT_BROKER_BASE_URL?.trim() } }
            steps {
                withCredentials([usernamePassword(credentialsId: params.PACT_BROKER_CREDENTIALS_ID,
                                                  usernameVariable: 'PACT_BROKER_USERNAME',
                                                  passwordVariable: 'PACT_BROKER_PASSWORD')]) {
                    withEnv(["PACT_BROKER_BASE_URL=${params.PACT_BROKER_BASE_URL}",
                             "PACT_PROVIDER_VERSION=${env.GIT_COMMIT}",
                             "PACT_PROVIDER_BRANCH=${env.BRANCH_NAME ?: 'main'}"]) {
                        // pact do test đơn vị của wallet (consumer) sinh ra ở stage Test, nằm trong ./pacts
                        sh '''
                            set -eu
                            docker run --rm -v "$WORKSPACE/pacts:/pacts" \
                              -e PACT_BROKER_BASE_URL -e PACT_BROKER_USERNAME -e PACT_BROKER_PASSWORD \
                              pactfoundation/pact-cli:latest pact-broker publish /pacts \
                              --consumer-app-version "$PACT_PROVIDER_VERSION" --branch "$PACT_PROVIDER_BRANCH"
                            PACT_PUBLISH_VERIFICATION=true corepack pnpm test:contract
                        '''
                        script {
                            def status = sh(returnStatus: true, script: '''
                                docker run --rm \
                                  -e PACT_BROKER_BASE_URL -e PACT_BROKER_USERNAME -e PACT_BROKER_PASSWORD \
                                  pactfoundation/pact-cli:latest pact-broker can-i-deploy \
                                  --pacticipant wallet --version "$PACT_PROVIDER_VERSION"
                            ''')
                            if (status != 0) {
                                if (params.PACT_ENFORCE_CAN_I_DEPLOY) {
                                    error('can-i-deploy: không an toàn để triển khai wallet')
                                } else {
                                    unstable('can-i-deploy: "no" (chỉ cảnh báo cho đến khi ecommerce verify pact)')
                                }
                            }
                        }
                    }
                }
            }
        }

        stage('SonarQube') {
            steps {
                withSonarQubeEnv(params.SONARQUBE_SERVER) {
                    sh 'sonar-scanner'
                }
            }
        }

        stage('Quality Gate') {
            steps {
                timeout(time: 10, unit: 'MINUTES') {
                    waitForQualityGate abortPipeline: true
                }
            }
        }
    }
}
