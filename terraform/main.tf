# EKS Simulator on ECS Fargate — deliberately tiny and non-scaling.
# One Spot task, direct public IP, no ALB, no NAT: total cost ~$7/month.

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# ---------------------------------------------------------------------------
# Variables
# ---------------------------------------------------------------------------

variable "region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "ap-south-1"
}

variable "image" {
  description = "Container image (public Docker Hub repo, pinned tag)"
  type        = string
  default     = "tilak83docker/eks_simulator:1.0"
}

variable "app_port" {
  description = "Port the Node server listens on"
  type        = number
  default     = 3000
}

variable "budget_email" {
  description = "Email address that receives the monthly budget alert"
  type        = string
}

provider "aws" {
  region = var.region
}

locals {
  name = "eks-simulator"
}

# ---------------------------------------------------------------------------
# Networking — reuse the default VPC's public subnets (no NAT gateway cost)
# ---------------------------------------------------------------------------

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "public" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

resource "aws_security_group" "app" {
  name        = "${local.name}-sg"
  description = "Allow HTTP to the simulator only"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "App traffic from anywhere"
    from_port   = var.app_port
    to_port     = var.app_port
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Outbound needed to pull the image from Docker Hub and ship logs
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ---------------------------------------------------------------------------
# Logs and IAM — least privilege: execution role only, no task role
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${local.name}"
  retention_in_days = 7
}

resource "aws_iam_role" "execution" {
  name = "${local.name}-execution"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# ---------------------------------------------------------------------------
# ECS — cluster, task, service (Fargate Spot, single task, no autoscaling)
# ---------------------------------------------------------------------------

resource "aws_ecs_cluster" "main" {
  name = local.name
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 1
  }
}

resource "aws_ecs_task_definition" "app" {
  family                   = local.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = local.name
    image     = var.image
    essential = true

    portMappings = [{
      containerPort = var.app_port
      protocol      = "tcp"
    }]

    environment = [
      { name = "PORT", value = tostring(var.app_port) },
      { name = "NODE_ENV", value = "production" },
    ]

    # The image already runs as the non-root "node" user; the app keeps all
    # state in memory, so the root filesystem can be locked read-only.
    readonlyRootFilesystem = true

    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"fetch('http://localhost:'+process.env.PORT+'/api/state').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 10
    }

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.app.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "app"
      }
    }
  }])
}

resource "aws_ecs_service" "app" {
  name            = local.name
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = 1

  # Never run more than one task, even during deploys — cost cap over uptime.
  deployment_maximum_percent         = 100
  deployment_minimum_healthy_percent = 0

  capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 1
  }

  network_configuration {
    subnets          = data.aws_subnets.public.ids
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = true
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
}

# ---------------------------------------------------------------------------
# Cost tripwire — email alert at 80% of a $10/month budget
# ---------------------------------------------------------------------------

resource "aws_budgets_budget" "monthly" {
  name         = "${local.name}-monthly"
  budget_type  = "COST"
  limit_amount = "10"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_email]
  }
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "service_name" {
  value = aws_ecs_service.app.name
}

# The task's public IP is assigned at runtime, so Terraform can't output it
# directly. Run this after apply (and after any task restart) to find it.
output "get_public_ip_command" {
  value = <<-EOT
    aws ecs list-tasks --cluster ${local.name} --service-name ${local.name} --region ${var.region} --query taskArns[0] --output text |
    % { aws ecs describe-tasks --cluster ${local.name} --tasks $_ --region ${var.region} --query "tasks[0].attachments[0].details[?name=='networkInterfaceId'].value" --output text } |
    % { aws ec2 describe-network-interfaces --network-interface-ids $_ --region ${var.region} --query "NetworkInterfaces[0].Association.PublicIp" --output text }
  EOT
}
