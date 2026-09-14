FROM public.ecr.aws/lambda/nodejs:22
# Copy lambda entry maintaining directory structure so relative imports resolve:
#   ../../../server/config.mjs etc. from infra/lambdas/poller/index.mjs
COPY infra/lambdas/poller/index.mjs ${LAMBDA_TASK_ROOT}/infra/lambdas/poller/
COPY server/ ${LAMBDA_TASK_ROOT}/server/
# Copy corridor GeoJSON data (DATA_DIR=/var/task/data)
COPY public/data/ ${LAMBDA_TASK_ROOT}/data/
CMD ["infra/lambdas/poller/index.handler"]
