all:
  children:
    tasky_servers:
      hosts:
%{ for host in hosts ~}
        ${host.name}:
          ansible_host: ${host.ansible_host}
          ansible_user: ${try(host.ansible_user, "ubuntu")}
%{ if try(host.ansible_ssh_private_key_file, "") != "" ~}
          ansible_ssh_private_key_file: ${host.ansible_ssh_private_key_file}
%{ endif ~}
          ansible_become: ${try(host.ansible_become, true)}
%{ if try(host.ansible_ssh_common_args, "") != "" ~}
          ansible_ssh_common_args: ${host.ansible_ssh_common_args}
%{ endif ~}
          customer_name: ${try(host.customer_name, host.customer)}
%{ if try(host.ui_domain, "") != "" ~}
          ui_domain: ${host.ui_domain}
%{ endif ~}
%{ if try(host.ui_port, 0) != 0 ~}
          ui_port: ${host.ui_port}
%{ endif ~}
%{ if try(host.api_domain, "") != "" ~}
          api_domain: ${host.api_domain}
%{ endif ~}
%{ if try(host.api_port, 0) != 0 ~}
          api_port: ${host.api_port}
%{ endif ~}
%{ endfor ~}
