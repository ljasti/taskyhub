#!/usr/bin/env bash
set -euo pipefail

PWD_LOWER="$(pwd | tr '[:upper:]' '[:lower:]')"
if [[ "$PWD_LOWER" != *"/envs/aws/dev/"* ]] && [[ "$PWD_LOWER" != *"\\envs\\aws\\dev\\"* ]]; then
  echo "Refusing to run destroy: not in an aws/dev env directory."
  echo "Expected path to include: envs/aws/dev/<customer>"
  exit 1
fi

terraform init
terraform plan -destroy -out=destroy.tfplan
terraform show destroy.tfplan

read -r -p "Apply destroy plan? (type 'yes' to confirm): " CONFIRM
if [[ "$CONFIRM" == "yes" ]]; then
  terraform apply destroy.tfplan
  rm -f destroy.tfplan
else
  echo "Aborted."
fi
