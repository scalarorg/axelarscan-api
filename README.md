# Axelarscan API

## Endpoints
- [https://api.axelarscan.io](https://api.axelarscan.io)
- [https://testnet.api.axelarscan.io](https://testnet.api.axelarscan.io)

## Stacks
- AWS Opensearch
- AWS Lambda
- AWS API Gateway
- AWS EventBridge
- Docker Compose
- Node.js

## Deployment
### Prerequisites
1. [Install AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-prereqs.html)
2. [Configuring the AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/cli-chap-configure.html)
3. [Install terraform](https://learn.hashicorp.com/tutorials/terraform/install-cli)
4. [Install npm](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)

### Deploy agent on RPC node
[Setup agent](/agent)

### Install dependencies
```
cd functions/api
npm i
```

### Deploy services
```
cd terraform/testnet
terraform init
terraform apply
```
