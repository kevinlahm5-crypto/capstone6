# Capstone 6 — Resilient Container Platform & CI/CD

A containerized e-commerce platform on **ECS Fargate**, spanning two Availability
Zones, with RDS Multi-AZ + ElastiCache for data/caching, SQS-decoupled async
order processing that autoscales workers on queue depth, AWS Backup + Route 53
failover for disaster recovery, and a serverless CodePipeline/CodeBuild CI/CD
pipeline that builds Docker images and rolls out blue/green ECS deployments.

## Repository layout

```
app/web/        Frontend web service (Node/Express) — cached reads via Redis,
                 publishes orders to SQS
app/worker/     Backend worker — long-polls SQS, processes orders
pipeline/       buildspec-web.yml, buildspec-worker.yml, appspec.yml, taskdef-web.json
infrastructure/ CloudFormation templates, deployed in numeric order
```

## Architecture diagram

> _Insert your diagram here_ (draw.io / Lucidchart / AWS-icon PNG). It should show:
> the VPC with 2 AZs (public subnets with ALB/NAT, private subnets with
> ECS/RDS/ElastiCache), the SQS decoupling between the web and worker services,
> the CodePipeline → CodeBuild → ECR → CodeDeploy/ECS flow, and the Route 53
> primary/secondary failover targets.

## Deployment order

All templates live in `infrastructure/` and are numbered in the order they must
be deployed, because later stacks import outputs from earlier ones via
`Fn::ImportValue`.

```bash
export ENV=capstone6
export REGION=us-east-1
export DB_PASSWORD='ChooseAStrongPassword123!'

# 1. Networking
aws cloudformation deploy \
  --template-file infrastructure/01-network.yaml \
  --stack-name ${ENV}-network \
  --parameter-overrides EnvName=$ENV \
  --region $REGION

# 2. Data layer (RDS Multi-AZ + ElastiCache) — takes ~10-15 min
aws cloudformation deploy \
  --template-file infrastructure/02-data.yaml \
  --stack-name ${ENV}-data \
  --parameter-overrides EnvName=$ENV DBPassword=$DB_PASSWORD \
  --capabilities CAPABILITY_IAM \
  --region $REGION

# 3. SQS queue + DLQ
aws cloudformation deploy \
  --template-file infrastructure/03-sqs.yaml \
  --stack-name ${ENV}-sqs \
  --parameter-overrides EnvName=$ENV \
  --region $REGION

# 4. ECS cluster, ALB, ECR repos
aws cloudformation deploy \
  --template-file infrastructure/04-ecs-cluster.yaml \
  --stack-name ${ENV}-ecs-cluster \
  --parameter-overrides EnvName=$ENV \
  --region $REGION

# --- Build & push initial images so the services have something to run ---
WEB_REPO=$(aws cloudformation describe-stacks --stack-name ${ENV}-ecs-cluster \
  --query "Stacks[0].Outputs[?OutputKey=='WebRepoUri'].OutputValue" --output text)
WORKER_REPO=$(aws cloudformation describe-stacks --stack-name ${ENV}-ecs-cluster \
  --query "Stacks[0].Outputs[?OutputKey=='WorkerRepoUri'].OutputValue" --output text)

aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin ${WEB_REPO%/*}

docker build -t $WEB_REPO:latest app/web && docker push $WEB_REPO:latest
docker build -t $WORKER_REPO:latest app/worker && docker push $WORKER_REPO:latest

# 5. ECS services (web + worker) with target-tracking auto scaling
aws cloudformation deploy \
  --template-file infrastructure/05-ecs-services.yaml \
  --stack-name ${ENV}-ecs-services \
  --parameter-overrides EnvName=$ENV WebImage=$WEB_REPO:latest WorkerImage=$WORKER_REPO:latest DBPassword=$DB_PASSWORD \
  --capabilities CAPABILITY_IAM \
  --region $REGION

# 6. AWS Backup plan
aws cloudformation deploy \
  --template-file infrastructure/06-backup.yaml \
  --stack-name ${ENV}-backup \
  --parameter-overrides EnvName=$ENV \
  --capabilities CAPABILITY_IAM \
  --region $REGION

# 7. Route 53 failover (needs a hosted zone you own)
aws cloudformation deploy \
  --template-file infrastructure/07-route53-failover.yaml \
  --stack-name ${ENV}-dns \
  --parameter-overrides EnvName=$ENV HostedZoneId=ZXXXXXXXXXXXX RecordName=shop.example.com \
  --region $REGION

# 8. CI/CD pipeline (needs a CodeStar Connections ARN to your GitHub repo,
#    created once via: aws codestar-connections create-connection --provider-type GitHub --connection-name capstone6)
aws cloudformation deploy \
  --template-file infrastructure/08-pipeline.yaml \
  --stack-name ${ENV}-pipeline \
  --parameter-overrides EnvName=$ENV GitHubOwner=<you> GitHubRepo=<repo> CodeStarConnectionArn=<arn> \
  --capabilities CAPABILITY_IAM \
  --region $REGION
```

## Evidence to capture for grading

- [ ] **Architecture diagram** — embed above.
- [ ] **CI/CD proof** — screenshot of a green CodePipeline execution
      (`aws codepipeline get-pipeline-state --name ${ENV}-pipeline`).
- [ ] **Scaling proof** — CloudWatch screenshot of `ECS RunningTaskCount` or
      `SQS ApproximateNumberOfMessagesVisible` rising then the worker service
      task count scaling out in response. Generate load with:
      `for i in {1..500}; do curl -s -X POST $ALB_DNS/orders -d '{"items":["x"]}' -H 'Content-Type: application/json' & done`
- [ ] **DR runbook & failover proof** — screenshot of the AWS Backup plan +
      a completed backup job, plus a description of a simulated failure
      (e.g., stop the ALB targets or force an RDS failover with
      `aws rds reboot-db-instance --db-instance-identifier ${ENV}-db --force-failover`)
      and a screenshot/log showing Route 53 shifted traffic to the secondary record.

## Notes / things to double check before submitting

- `05-ecs-services.yaml` and `08-pipeline.yaml` both import the ALB security
  group ID and listener ARN from `04-ecs-cluster.yaml`'s outputs
  (`${EnvName}-alb-sg-id`, `${EnvName}-alb-listener-arn`) — so stack 4 must be
  deployed before stacks 5 and 8.
- Secrets (`DBPassword`) are passed as CloudFormation parameters here for
  simplicity; for production/graded rigor, move them to AWS Secrets Manager
  and reference via `secrets:` in the task definition instead of plaintext
  `environment:`.
- Route 53 hosted-zone alias `HostedZoneId` values in `07-route53-failover.yaml`
  are for `us-east-1`; update if deploying elsewhere.
