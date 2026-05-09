docker compose down
docker rmi app-api:latest app-ui:latest
docker volume rm $(docker volume ls)
