# MCMF Terraform runner microservice — Node + the Terraform CLI, nothing else.
FROM node:20-alpine
ARG TERRAFORM_VERSION=1.9.8
RUN apk add --no-cache curl unzip ca-certificates \
 && curl -fsSL "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip" -o /tmp/tf.zip \
 && unzip /tmp/tf.zip -d /usr/local/bin && rm /tmp/tf.zip \
 && terraform version
WORKDIR /app
COPY server.js .
RUN mkdir -p /work /plugins
ENV TF_PLUGIN_CACHE_DIR=/plugins TF_WORK_DIR=/work
EXPOSE 8080
CMD ["node", "server.js"]
