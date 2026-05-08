all:
  children:
    tasky_servers:
      hosts:
%{ for host in hosts ~}
        ${host.name}:
          ansible_host: ${host.ansible_host}
          ansible_user: ubuntu
          ansible_become: yes
          customer_name: ${host.customer}
%{ endfor ~}
