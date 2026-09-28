FROM public.ecr.aws/lambda/nodejs:22
# Build context: cesium-poc/. Copy lambda entry maintaining directory structure so relative imports resolve:
#   ../../../server/config.mjs etc. from infra/lambdas/poller/index.mjs
COPY infra/lambdas/poller/ ${LAMBDA_TASK_ROOT}/infra/lambdas/poller/
COPY server/ ${LAMBDA_TASK_ROOT}/server/
# Live DataConnect cycle: class/workflow config and the Operational Impact model it imports
COPY config/liveDc/ ${LAMBDA_TASK_ROOT}/config/liveDc/
COPY src/liveOps/ ${LAMBDA_TASK_ROOT}/src/liveOps/
COPY src/weather/ ${LAMBDA_TASK_ROOT}/src/weather/
# Copy corridor GeoJSON data (DATA_DIR=/var/task/data; set LIVE_DC_DATA_DIR to the same)
COPY public/data/ ${LAMBDA_TASK_ROOT}/data/
# src/liveOps/*.js are ES modules
RUN echo '{"type":"module"}' > ${LAMBDA_TASK_ROOT}/package.json
ENV DATA_DIR=/var/task/data LIVE_DC_DATA_DIR=/var/task/data
CMD ["infra/lambdas/poller/index.handler"]
