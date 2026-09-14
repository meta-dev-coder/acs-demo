import * as cdk from 'aws-cdk-lib'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as events from 'aws-cdk-lib/aws-events'
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as scheduler from 'aws-cdk-lib/aws-scheduler'
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2'
import * as path from 'path'
import { Construct } from 'constructs'

export class I595Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    // ── 1. S3 Data Bucket ────────────────────────────────────────────────────
    const dataBucket = new s3.Bucket(this, 'i595CorridorData', {
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
        },
      ],
    })

    // ── 2. DynamoDB: live events ──────────────────────────────────────────────
    const liveEventsTable = new dynamodb.Table(this, 'I595LiveEvents', {
      partitionKey: { name: 'eventId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
    })

    // ── 3. DynamoDB: WebSocket connections ───────────────────────────────────
    const wsConnectionsTable = new dynamodb.Table(this, 'I595WsConnections', {
      partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
    })

    // ── 4. EventBridge custom bus ─────────────────────────────────────────────
    const eventsBus = new events.EventBus(this, 'I595EventsBus', {
      eventBusName: 'i595-events',
    })

    // ── 5. Lambda: poller ─────────────────────────────────────────────────────
    const pollerFn = new NodejsFunction(this, 'PollerFn', {
      entry: path.join(__dirname, '../lambdas/poller/index.mjs'),
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      bundling: {
        format: OutputFormat.ESM,
        externalModules: ['@aws-sdk/*'],
        commandHooks: {
          afterBundling(inputDir: string, outputDir: string): string[] {
            const dataDir = path.join(__dirname, '../../public/data');
            return [`cp -r ${dataDir} ${outputDir}/data`];
          },
          beforeBundling(): string[] { return []; },
          beforeInstall(): string[] { return []; },
        },
      },
      environment: {
        LIVE_EVENTS_TABLE: liveEventsTable.tableName,
        EVENTS_BUS_ARN: eventsBus.eventBusArn,
        DATA_DIR: '/var/task/data',
      },
    })

    liveEventsTable.grantReadWriteData(pollerFn)
    eventsBus.grantPutEventsTo(pollerFn)

    // ── 6. EventBridge Scheduler: run poller every 1 minute ──────────────────
    const schedulerRole = new iam.Role(this, 'PollerSchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    })
    schedulerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [pollerFn.functionArn],
      }),
    )

    new scheduler.CfnSchedule(this, 'PollerSchedule', {
      name: 'i595-poller',
      scheduleExpression: 'rate(10 minutes)',
      flexibleTimeWindow: {
        mode: 'FLEXIBLE',
        maximumWindowInMinutes: 2,
      },
      target: {
        arn: pollerFn.functionArn,
        roleArn: schedulerRole.roleArn,
      },
    })

    // ── 7. Lambda: snapshot proxy ─────────────────────────────────────────────
    const snapshotProxyFn = new NodejsFunction(this, 'SnapshotProxyFn', {
      entry: path.join(__dirname, '../lambdas/snapshot-proxy/index.mjs'),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(10),
      bundling: {
        format: OutputFormat.ESM,
        externalModules: ['@aws-sdk/*'],
      },
      environment: {
        KNOWN_CHAN_IDS: '',
      },
    })

    const snapshotProxyFnUrl = snapshotProxyFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    })

    // ── 8. Lambda: WebSocket handlers ────────────────────────────────────────
    const wsHandlerCommon = {
      entry: path.join(__dirname, '../lambdas/ws-handler/index.mjs'),
      runtime: lambda.Runtime.NODEJS_22_X,
      bundling: {
        format: OutputFormat.ESM,
        externalModules: ['@aws-sdk/*'] as string[],
      },
    } as const

    const wsConnectFn = new NodejsFunction(this, 'WsConnectFn', {
      ...wsHandlerCommon,
      handler: 'connect',
      environment: {
        CONNECTIONS_TABLE: wsConnectionsTable.tableName,
        LIVE_EVENTS_TABLE: liveEventsTable.tableName,
      },
    })

    const wsDisconnectFn = new NodejsFunction(this, 'WsDisconnectFn', {
      ...wsHandlerCommon,
      handler: 'disconnect',
      environment: {
        CONNECTIONS_TABLE: wsConnectionsTable.tableName,
        LIVE_EVENTS_TABLE: liveEventsTable.tableName,
      },
    })

    const wsDefaultFn = new NodejsFunction(this, 'WsDefaultFn', {
      ...wsHandlerCommon,
      handler: 'defaultHandler',
      environment: {
        CONNECTIONS_TABLE: wsConnectionsTable.tableName,
        LIVE_EVENTS_TABLE: liveEventsTable.tableName,
      },
    })

    wsConnectionsTable.grantReadWriteData(wsConnectFn)
    wsConnectionsTable.grantReadWriteData(wsDisconnectFn)
    wsConnectionsTable.grantReadWriteData(wsDefaultFn)
    liveEventsTable.grantReadData(wsDefaultFn)

    // ── 9. API Gateway WebSocket API (L1 — avoids alpha-package synthesis bugs) ─
    const wsApi = new apigw.CfnApi(this, 'I595WsApi', {
      name: 'i595-websocket-api',
      protocolType: 'WEBSOCKET',
      routeSelectionExpression: '$request.body.action',
    })

    const makeWsInteg = (id: string, fn: lambda.IFunction) =>
      new apigw.CfnIntegration(this, id, {
        apiId: wsApi.ref,
        integrationType: 'AWS_PROXY',
        integrationUri: cdk.Stack.of(this).formatArn({
          service: 'apigateway',
          account: 'lambda',
          resource: 'path/2015-03-31/functions',
          resourceName: `${fn.functionArn}/invocations`,
        }),
      })

    const wsConnectInteg    = makeWsInteg('WsConnectInteg',    wsConnectFn)
    const wsDisconnectInteg = makeWsInteg('WsDisconnectInteg', wsDisconnectFn)
    const wsDefaultInteg    = makeWsInteg('WsDefaultInteg',    wsDefaultFn)

    new apigw.CfnRoute(this, 'WsConnectRoute',    { apiId: wsApi.ref, routeKey: '$connect',    target: `integrations/${wsConnectInteg.ref}` })
    new apigw.CfnRoute(this, 'WsDisconnectRoute', { apiId: wsApi.ref, routeKey: '$disconnect', target: `integrations/${wsDisconnectInteg.ref}` })
    new apigw.CfnRoute(this, 'WsDefaultRoute',    { apiId: wsApi.ref, routeKey: '$default',    target: `integrations/${wsDefaultInteg.ref}` })

    new apigw.CfnStage(this, 'I595WsStage', {
      apiId: wsApi.ref,
      stageName: 'prod',
      autoDeploy: true,
    })

    const wsCallbackUrl = `https://${wsApi.ref}.execute-api.${this.region}.amazonaws.com/prod`
    const wsWssUrl      = `wss://${wsApi.ref}.execute-api.${this.region}.amazonaws.com/prod`

    const wsApiArn = cdk.Stack.of(this).formatArn({ service: 'execute-api', resource: wsApi.ref })
    for (const [fn, key] of [[wsConnectFn, 'connect'], [wsDisconnectFn, 'disconnect'], [wsDefaultFn, 'default']] as [lambda.IFunction, string][]) {
      fn.addPermission(`WsApiGw${key}Permission`, {
        principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
        sourceArn: `${wsApiArn}/*/*$${key}`,
      })
    }

    wsDefaultFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['execute-api:ManageConnections'],
      resources: [`${wsApiArn}/prod/*/@connections/*`],
    }))

    // ── 10. Lambda: broadcaster ───────────────────────────────────────────────
    const broadcasterFn = new NodejsFunction(this, 'BroadcasterFn', {
      entry: path.join(__dirname, '../lambdas/broadcaster/index.mjs'),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      bundling: {
        format: OutputFormat.ESM,
        externalModules: ['@aws-sdk/*'],
      },
      environment: {
        CONNECTIONS_TABLE: wsConnectionsTable.tableName,
        WS_API_ENDPOINT: wsCallbackUrl,
      },
    })

    wsConnectionsTable.grantReadWriteData(broadcasterFn)
    broadcasterFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['execute-api:ManageConnections'],
      resources: [`${wsApiArn}/prod/*/@connections/*`],
    }))

    new events.Rule(this, 'EventsChangedRule', {
      eventBus: eventsBus,
      eventPattern: { detailType: ['EventsChanged'] },
      targets: [new eventsTargets.LambdaFunction(broadcasterFn)],
    })

    // ── 11. Lambda: live-events REST ──────────────────────────────────────────
    const liveEventsRestFn = new NodejsFunction(this, 'LiveEventsRestFn', {
      entry: path.join(__dirname, '../lambdas/live-events-rest/index.mjs'),
      runtime: lambda.Runtime.NODEJS_22_X,
      bundling: {
        format: OutputFormat.ESM,
        externalModules: ['@aws-sdk/*'],
      },
      environment: {
        LIVE_EVENTS_TABLE: liveEventsTable.tableName,
      },
    })

    liveEventsTable.grantReadData(liveEventsRestFn)

    const liveEventsRestFnUrl = liveEventsRestFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    })

    // ── 12. Lambda: Ask the Twin ────────────────────────────────────────────────
    const askTheTwinFn = new NodejsFunction(this, 'AskTheTwinFn', {
      entry: path.join(__dirname, '../lambdas/ask-the-twin/index.mjs'),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      bundling: {
        format: OutputFormat.ESM,
        externalModules: ['@aws-sdk/*'],
      },
      environment: {
        LIVE_EVENTS_TABLE: liveEventsTable.tableName,
        ANTHROPIC_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:589391957147:secret:i595/anthropic-key-YFA1UV',
        ANTHROPIC_SECRET_REGION: 'us-east-1',
      },
    })

    liveEventsTable.grantReadData(askTheTwinFn)

    askTheTwinFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: ['arn:aws:secretsmanager:us-east-1:589391957147:secret:i595/anthropic-key-YFA1UV'],
    }))

    const askTheTwinFnUrl = askTheTwinFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    })

    // ── 13. CloudFront Distribution ───────────────────────────────────────────
    const oac = new cloudfront.CfnOriginAccessControl(this, 'DataBucketOAC', {
      originAccessControlConfig: {
        name: 'i595-data-bucket-oac',
        originAccessControlOriginType: 's3',
        signingBehavior: 'always',
        signingProtocol: 'sigv4',
      },
    })

    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(dataBucket)

    const staticDataCachePolicy = new cloudfront.CachePolicy(this, 'StaticDataCachePolicy', {
      defaultTtl: cdk.Duration.seconds(86400),
      maxTtl: cdk.Duration.seconds(86400),
      minTtl: cdk.Duration.seconds(0),
    })

    const snapshotCachePolicy = new cloudfront.CachePolicy(this, 'SnapshotCachePolicy', {
      defaultTtl: cdk.Duration.seconds(60),
      maxTtl: cdk.Duration.seconds(90),
      minTtl: cdk.Duration.seconds(0),
    })

    const distribution = new cloudfront.Distribution(this, 'I595Distribution', {
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        '/data/*': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: staticDataCachePolicy,
        },
        '/api/i595/camera/*': {
          origin: new origins.FunctionUrlOrigin(snapshotProxyFnUrl),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        },
        '/api/i595/live-events*': {
          origin: new origins.FunctionUrlOrigin(liveEventsRestFnUrl),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        },
        '/api/i595/ask*': {
          origin: new origins.FunctionUrlOrigin(askTheTwinFnUrl),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        },
      },
    })

    const cfnDistribution = distribution.node.defaultChild as cloudfront.CfnDistribution
    cfnDistribution.addPropertyOverride(
      'DistributionConfig.Origins.0.OriginAccessControlId',
      oac.attrId,
    )
    cfnDistribution.addPropertyOverride(
      'DistributionConfig.Origins.0.S3OriginConfig.OriginAccessIdentity',
      '',
    )

    dataBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        resources: [dataBucket.arnForObjects('*')],
        conditions: {
          StringEquals: {
            'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
          },
        },
      }),
    )

    // ── 14. CfnOutputs ────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'CloudFrontDomain', {
      value: distribution.distributionDomainName,
    })

    new cdk.CfnOutput(this, 'WsEndpoint', {
      value: wsWssUrl,
    })

    new cdk.CfnOutput(this, 'DataBucketName', {
      value: dataBucket.bucketName,
    })

    new cdk.CfnOutput(this, 'SnapshotFunctionUrl', {
      value: snapshotProxyFnUrl.url,
    })

    new cdk.CfnOutput(this, 'LiveEventsFunctionUrl', {
      value: liveEventsRestFnUrl.url,
    })

    new cdk.CfnOutput(this, 'AskTheTwinFunctionUrl', {
      value: askTheTwinFnUrl.url,
    })
  }
}
