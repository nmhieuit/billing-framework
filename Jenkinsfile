#!/usr/bin/env groovy

// CI cho billing-framework. Agent cần: POSIX shell, Node 22 với corepack, Docker daemon
// (tầng integration về sau dùng testcontainers), và sonar-scanner trong PATH.
pipeline {
    agent any

    parameters {
        string(name: 'SONARQUBE_SERVER', defaultValue: 'sonarqube',
               description: 'Tên SonarQube server đã cấu hình trong Jenkins (phải khớp nền tảng dùng chung)')
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
