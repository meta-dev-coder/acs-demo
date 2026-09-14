FROM public.ecr.aws/lambda/nodejs:22
COPY index.mjs ${LAMBDA_TASK_ROOT}/
# CMD is overridden per function (connect / disconnect / defaultHandler)
CMD ["index.connect"]
