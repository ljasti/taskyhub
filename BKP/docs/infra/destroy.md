# Destroying Non-Production Terraform Environments (Safe)

This procedure is **only** for non-production environments (example: `dev`). Do not use it for `prod`.

## Prerequisites
- You are in the correct env/customer directory (example: `infra/terraform/envs/aws/dev/mummy`).
- You understand that destroy permanently deletes infrastructure for that env/customer.
- You have backups if the stack includes data you care about (databases, volumes, etc.).

## Why This Is Safe
- We use a **directory-per-env+customer** structure so each environment has its own state and can be destroyed independently.
- The destroy flow uses a **destroy plan** first, and requires a human “yes” confirmation before applying.

## Destroy a Customer Dev Stack
```bash
cd infra/terraform/envs/aws/dev/mummy
./destroy.sh
```

## Best Practices
- Separate state per environment:
  - Keep `dev` and `prod` in different directories and different state keys/paths.
- Protect production databases:
  - Add `lifecycle { prevent_destroy = true }` to production database resources (RDS, Aurora, etc.) to block accidental deletion. [web:5]
- Never “destroy” production:
  - Only tear down production through an explicit, reviewed change process (and usually by scaling down or replacing, not destroying).

## Common Mistakes (Avoid These)
- Running destroy from the wrong directory (double-check the path before running).
- Destroying without reviewing the plan output.
- Assuming `prevent_destroy` protects resources if you remove them from configuration (it does not; the protection only applies while the lifecycle rule is present). [web:5]
