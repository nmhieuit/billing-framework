#!/usr/bin/env groovy

// CI cho billing-framework. Agent cần: POSIX shell, Node 22 với corepack, Docker daemon
// (tầng integration về sau dùng testcontainers), và sonar-scanner trong PATH.
pipeline {
    agent any

    parameters {
        string(name: 'SONARQUBE_SERVER', defaultValue: 'sonarqube',
               description: 'Tên SonarQube server đã cấu hình trong Jenkins (phải khớp nền tảng dùng chung)')
        // Cố ý KHÔNG có tham số cho địa chỉ Pact Broker hay credentials id: người có quyền "Build with Parameters"
        // sẽ trỏ được credential cố định tới một host tùy ý (rò rỉ mật khẩu). Địa chỉ broker lấy từ biến môi
        // trường do job/folder định nghĩa (env.PACT_BROKER_BASE_URL); không định nghĩa thì bỏ qua stage Pact.
        booleanParam(name: 'PACT_ENFORCE_CAN_I_DEPLOY', defaultValue: false,
                     description: 'Bật khi ecommerce đã verify pact: can-i-deploy "no" sẽ làm hỏng build thay vì chỉ cảnh báo')
    }

    environment {
        // pact-cli 1.78.0, ghim theo digest (không dùng `latest`); đổi phiên bản = đổi digest ở đây và kiểm tra lại
        // `pact-broker publish` / `can-i-deploy`.
        PACT_CLI_IMAGE = 'pactfoundation/pact-cli@sha256:72f1df83a7c42abd02e69a0fa21c3adc037d72c2852daa9f2910bb35617b207b'
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
            when { expression { env.PACT_BROKER_BASE_URL?.trim() } }
            steps {
                // Credentials id cố định, địa chỉ broker từ env của job/folder (xem ghi chú ở phần parameters).
                withCredentials([usernamePassword(credentialsId: 'pact-broker',
                                                  usernameVariable: 'PACT_BROKER_USERNAME',
                                                  passwordVariable: 'PACT_BROKER_PASSWORD')]) {
                    withEnv(["PACT_PROVIDER_VERSION=${env.GIT_COMMIT}",
                             "PACT_PROVIDER_BRANCH=${env.BRANCH_NAME ?: 'main'}"]) {
                        // pact do test đơn vị của wallet (consumer) sinh ra ở stage Test, nằm trong ./pacts
                        sh '''
                            set -eu
                            docker run --rm -v "$WORKSPACE/pacts:/pacts" \
                              -e PACT_BROKER_BASE_URL -e PACT_BROKER_USERNAME -e PACT_BROKER_PASSWORD \
                              "$PACT_CLI_IMAGE" pact-broker publish /pacts \
                              --consumer-app-version "$PACT_PROVIDER_VERSION" --branch "$PACT_PROVIDER_BRANCH"
                            PACT_PUBLISH_VERIFICATION=true corepack pnpm test:contract
                        '''
                        script {
                            def status = sh(returnStatus: true, script: '''
                                docker run --rm \
                                  -e PACT_BROKER_BASE_URL -e PACT_BROKER_USERNAME -e PACT_BROKER_PASSWORD \
                                  "$PACT_CLI_IMAGE" pact-broker can-i-deploy \
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
