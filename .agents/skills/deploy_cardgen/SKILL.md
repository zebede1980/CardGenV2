---
name: deploy_cardgen
description: Instructions for deploying or updating the CardGenV2 docker container instance. Activate when the user asks to "deploy-chargen", "deploy cardgen", or "deploy".
---
# Deployment Workflow for CardGenV2

When the user requests to deploy or update the CardGenV2 application, follow these exact steps:

1. Use the `run_command` tool.
2. Set the `Cwd` (Current Working Directory) to `/home/ubuntu/DockerSource/CardGenV2`.
3. Execute the following sequence of commands to pull the latest code and rebuild the docker containers in detached mode:
   `git pull && docker compose up -d --build`

*Note: Do NOT attempt to run the user's `deploy-chargen` bash alias, as it is only available in their interactive shell.*
