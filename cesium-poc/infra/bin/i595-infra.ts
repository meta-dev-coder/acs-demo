#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib'
import { I595Stack } from '../lib/i595-stack'

const app = new cdk.App()

new I595Stack(app, 'I595StackV5', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  // Use a custom assets bucket with AES-256 (not the CDK bootstrap KMS bucket).
  // The CDK bootstrap bucket uses a customer KMS key whose policy blocks Lambda's
  // service from reading the encrypted zip files during CreateFunction.
  synthesizer: new cdk.CliCredentialsStackSynthesizer({
    fileAssetsBucketName: 'i595-deploy-assets-589391957147-us-east-1',
    bucketPrefix: '',
  }),
})

app.synth()
