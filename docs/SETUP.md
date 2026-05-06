# TaskyHub Infrastructure - Complete Setup Guide

## Prerequisites

1. **AWS Account Setup**
   - Create an AWS account at https://aws.amazon.com
   - Create an EC2 key pair and download the .pem file
   - Get your AWS Access Key ID and Secret Access Key from IAM console

2. **Install Required Tools**
   - Terraform: https://developer.hashicorp.com/terraform/downloads
   - Ansible: https://docs.ansible.com/ansible/latest/installation_guide/
   - AWS CLI: https://aws.amazon.com/cli/

3. **Namecheap Domain Setup**
   - Purchase a domain from Namecheap
   - Set up a subdomain (e.g., tasky.amroth.life)
   - You'll update DNS records after infrastructure is provisioned

## Step 1: Configure Credentials

1. **Copy the example configuration file:**
   ```bash
   cp config/config.env.example .env
   ```

2. **Edit `.env` with your values:**
   ```
   AWS_ACCESS_KEY_ID=your_actual_access_key
   AWS_SECRET_ACCESS_KEY=your_actual_secret_key
   AWS_REGION=us-east-1
   KEY_PAIR_NAME=your-ec2-key-pair-name
   CUSTOMER_NAME=tasky
   DOMAIN_NAME=tasky.amroth.life
   SSH_KEY_PATH=/home/username/.ssh/your-key-pair.pem
   N8N_PASSWORD=YourN8nPassword123!
   ADMIN_PASSWORD=YourAdminPassword123!
   USER_PASSWORD=YourUserPassword123!
   ```

## Step 2: Configure AWS CLI

```powershell
aws configure
# Enter:
# AWS Access Key ID: [your_key_id]
# AWS Secret Access Key: [your_secret_key]
# Default region: us-east-1
# Default output format: json
```

## Step 3: Run Infrastructure Deployment

**Single Command to Deploy Everything:**

```bash
chmod +x spinup.sh
./spinup.sh
```

Or with custom config file:
```bash
./spinup.sh config-acme.env
```

**PowerShell Alternative (Windows):**
```powershell
.\spinup.ps1
```

This script will:
1. ✓ Initialize Terraform
2. ✓ Create terraform.auto.tfvars with your configuration
3. ✓ Provision AWS EC2 instance
4. ✓ Update Ansible inventory with instance IP
5. ✓ Wait for instance to be ready
6. ✓ Run Ansible playbook to configure the server
7. ✓ Install Docker, nginx, certbot
8. ✓ Deploy n8n container
9. ✓ Configure SSL certificate
10. ✓ Deploy UI dashboard

## Step 4: Update Namecheap DNS Records

After deployment completes, you'll get the **Instance IP**. Update your Namecheap DNS:

1. Go to Namecheap Dashboard
2. Find your domain (amroth.life)
3. Go to Advanced DNS
4. Add/Update A record:
   - Host: @ for root, or use only the subdomain label for subdomains.
     - Example: `customer1` to serve `customer1.tasky.amroth.life`
     - Do not enter the full domain name in the Host field.
   - Type: A
   - Value: [INSTANCE_IP from deployment output]
5. Wait 5-10 minutes for DNS propagation

> Note: `terraform/user_data.sh` prepares the EC2 instance and basic tooling. The actual TaskyHub app deployment is performed by `ansible/playbook.yml`.

## Step 5: Access Your Application

Once DNS propagates:
- **Dashboard**: https://tasky.amroth.life
- **Analytics**: https://tasky.amroth.life/analytics
- **Admin Login**: admin / [ADMIN_PASSWORD from config.env]
- **User Login**: user / [USER_PASSWORD from config.env]
- **n8n Access**: https://tasky.amroth.life/n8n
- **n8n Credentials**: admin / [N8N_PASSWORD from config.env]

## Adding a New Customer

To deploy for a new customer (e.g., acme.amroth.life):

1. **Copy and update config:**
   ```bash
   cp .env config-acme.env
   # Edit config-acme.env with new customer details
   ```

2. **Run deployment with custom config:**
   ```bash
   ./spinup.sh config-acme.env
   ```

3. **Update DNS** in Namecheap with the new instance IP

**PowerShell Alternative:**
```powershell
Copy-Item .env config-acme.env
# Edit config-acme.env
.\spinup.ps1 -ConfigFile config-acme.env
```

## Manual Commands (if needed)

### Terraform Only
```powershell
cd terraform
terraform init
terraform plan
terraform apply
```

### Ansible Only
```powershell
cd ansible
ansible-playbook playbook.yml -i inventory.ini
```

### Destroy Infrastructure
```powershell
cd terraform
terraform destroy
```

## Troubleshooting

### SSL Certificate Issues
- Ensure DNS is pointing to the instance IP
- Check certificate status: `certbot certificates`
- Renew manually: `certbot renew --force-renewal`

### n8n Not Starting
```bash
# SSH into instance
ssh -i your-key.pem ubuntu@instance-ip

# Check n8n logs
cd /opt/tasky/n8n
docker compose logs -f tasky_n8n
```

### Ansible Connection Issues
- Verify SSH key permissions: `chmod 600 your-key.pem`
- Test SSH: `ssh -i your-key.pem ubuntu@instance-ip`
- Update SSH_KEY_PATH in config.env

## Security Notes

- **Change default passwords** in config.env before deployment
- **Restrict SSH access** in AWS Security Group (only your IP)
- **Use strong passwords** for all credentials
- **Enable 2FA** on AWS and Namecheap accounts
- **Backup n8n data** regularly: `/opt/[customer_name]/data/n8n`

## File Structure

```
infra/
├── terraform/
│   ├── main.tf              # AWS resource definitions
│   ├── variables.tf         # Variable declarations
│   ├── terraform.tfvars     # Default values (update manually)
│   ├── terraform.auto.tfvars # Auto-generated by spinup script
│   └── user_data.sh         # EC2 initialization script
├── ansible/
│   ├── playbook.yml         # Main ansible playbook
│   ├── ansible.cfg          # Ansible configuration
│   ├── inventory.ini        # Host inventory (auto-updated)
│   ├── vars.yml             # Variables (auto-updated)
│   └── templates/           # Jinja2 templates for config files
│       ├── tasky.conf.j2
│       ├── n8n/docker-compose.yml.j2
│       └── ui/
│           ├── index.html
│           ├── login.html
│           └── dashboard.html
├── app/                     # Application files (reference)
├── spinup.ps1               # Main deployment script
├── config.env.example       # Configuration template
└── README.md                # This file
```

## Support

For issues:
1. Check logs: `cat /var/log/syslog` on instance
2. Review Terraform/Ansible output
3. Verify DNS propagation: `nslookup tasky.amroth.life`
4. Check instance security groups in AWS console