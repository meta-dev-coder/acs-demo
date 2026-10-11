// Ask the Twin EC2 route behind CDK context flags (lib/i595-stack.ts section 12b).
// Run: npm test (node:test + ts-node, no AWS access; Lambda bundling is skipped so no esbuild/Docker needed).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as cdk from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { I595Stack } from '../lib/i595-stack'

const EC2_HOST = 'ec2-34-237-187-140.compute-1.amazonaws.com'
const EDGE_KEY_PARAM = '/i595/ask/edge-key'

function synth(context: Record<string, unknown> = {}): Template {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [], ...context } })
  const stack = new I595Stack(app, 'I595StackV5', { env: { account: '589391957147', region: 'us-east-1' } })
  return Template.fromStack(stack)
}

type Behavior = Record<string, any>
function distributionConfig(t: Template): Record<string, any> {
  const dists = Object.values(t.findResources('AWS::CloudFront::Distribution'))
  assert.equal(dists.length, 1)
  return dists[0].Properties.DistributionConfig
}
const behaviors = (t: Template): Behavior[] => distributionConfig(t).CacheBehaviors
const behaviorFor = (t: Template, pattern: string): Behavior | undefined =>
  behaviors(t).find(b => b.PathPattern === pattern)
const originById = (t: Template, id: string): Record<string, any> =>
  distributionConfig(t).Origins.find((o: any) => o.Id === id)

const ec2Context = { askOrigin: EC2_HOST, askEdgeKeyParam: EDGE_KEY_PARAM }

test('flag off: the Lambda keeps /api/i595/ask* and nothing new is added', () => {
  const t = synth()
  const ask = behaviorFor(t, '/api/i595/ask*')!
  assert.ok(ask, 'ask behaviour present')
  assert.equal(behaviorFor(t, '/api/i595/ask-lambda*'), undefined)
  assert.ok(originById(t, ask.TargetOriginId).CustomOriginConfig, 'targets the function URL origin')
  assert.equal(originById(t, ask.TargetOriginId).OriginCustomHeaders, undefined)
  assert.equal(ask.OriginRequestPolicyId, undefined)
  assert.equal(ask.Compress, true)
  assert.equal(distributionConfig(t).Origins.length, 4)
  t.resourceCountIs('AWS::CloudFront::OriginRequestPolicy', 0)
  t.resourceCountIs('AWS::CloudFront::ResponseHeadersPolicy', 0)
  t.resourceCountIs('AWS::Lambda::Url', 3)
  t.hasOutput('AskTheTwinFunctionUrl', {})
  assert.equal(Object.keys(t.toJSON().Outputs).includes('AskEc2Origin'), false)
  assert.equal(JSON.stringify(t.toJSON()).includes('x-ask-edge-key'), false)
})

test('flag off: an empty askOrigin is the same template as no context at all', () => {
  assert.deepEqual(synth({ askOrigin: '', retireAskLambda: 'false' }).toJSON(), synth().toJSON())
})

test('flag on: /api/i595/ask* goes to the EC2 origin, uncached, all methods, uncompressed', () => {
  const t = synth(ec2Context)
  const ask = behaviorFor(t, '/api/i595/ask*')!
  assert.equal(ask.CachePolicyId, '4135ea2d-6df8-44a3-9df3-4b5a84be39ad') // Managed-CachingDisabled
  assert.deepEqual([...ask.AllowedMethods].sort(), ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'])
  assert.equal(ask.Compress, false)
  assert.equal(ask.ViewerProtocolPolicy, 'redirect-to-https')

  const origin = originById(t, ask.TargetOriginId)
  assert.equal(origin.DomainName, EC2_HOST)
  assert.equal(origin.CustomOriginConfig.OriginProtocolPolicy, 'http-only')
  assert.equal(origin.CustomOriginConfig.HTTPPort, 8095)
  assert.equal(origin.CustomOriginConfig.OriginReadTimeout, 60)
  assert.equal(origin.CustomOriginConfig.OriginKeepaliveTimeout, 4)

  // The edge key is a deploy-time SSM reference, never a literal.
  const header = origin.OriginCustomHeaders.find((h: any) => h.HeaderName === 'x-ask-edge-key')
  assert.ok(header.HeaderValue.Ref, 'header value is a Ref')
  const param = t.toJSON().Parameters[header.HeaderValue.Ref]
  assert.equal(param.Type, 'AWS::SSM::Parameter::Value<String>')
  assert.equal(param.Default, EDGE_KEY_PARAM)

  t.hasResourceProperties('AWS::CloudFront::OriginRequestPolicy', {
    OriginRequestPolicyConfig: Match.objectLike({
      CookiesConfig: { CookieBehavior: 'none' },
      QueryStringsConfig: { QueryStringBehavior: 'none' },
      HeadersConfig: {
        HeaderBehavior: 'whitelist',
        Headers: Match.arrayWith(['Accept', 'Content-Type', 'CloudFront-Viewer-Address']),
      },
    }),
  })
  t.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
    ResponseHeadersPolicyConfig: Match.objectLike({
      CorsConfig: Match.objectLike({
        AccessControlAllowOrigins: { Items: ['https://meta-dev-coder.github.io'] },
        AccessControlAllowCredentials: false,
        OriginOverride: true,
      }),
    }),
  })
  t.hasOutput('AskEc2Origin', { Value: `${EC2_HOST}:8095 (http-only)` })
})

test('flag on, Lambda kept: it moves to /api/i595/ask-lambda*, ordered before /api/i595/ask*', () => {
  const t = synth(ec2Context)
  const patterns = behaviors(t).map(b => b.PathPattern)
  const lambdaAt = patterns.indexOf('/api/i595/ask-lambda*')
  const ec2At = patterns.indexOf('/api/i595/ask*')
  assert.ok(lambdaAt >= 0 && ec2At > lambdaAt, `order was ${patterns.join(', ')}`)
  const lambdaOrigin = originById(t, behaviors(t)[lambdaAt].TargetOriginId)
  assert.equal(lambdaOrigin.OriginCustomHeaders, undefined)
  assert.notEqual(lambdaOrigin.DomainName, EC2_HOST)
  t.resourceCountIs('AWS::Lambda::Url', 3)
  t.hasOutput('AskTheTwinFunctionUrl', {})
})

test('flag on, retireAskLambda=true: the Lambda, its URL, behaviour and output are gone', () => {
  const t = synth({ ...ec2Context, retireAskLambda: 'true' })
  assert.equal(behaviorFor(t, '/api/i595/ask-lambda*'), undefined)
  assert.equal(originById(t, behaviorFor(t, '/api/i595/ask*')!.TargetOriginId).DomainName, EC2_HOST)
  t.resourceCountIs('AWS::Lambda::Url', 2)
  assert.equal(Object.keys(t.toJSON().Outputs).includes('AskTheTwinFunctionUrl'), false)
  assert.equal(JSON.stringify(t.toJSON()).includes('ask-the-twin'), false)
})

test('port, protocol, keepalive and CORS origins come from context', () => {
  const t = synth({
    ...ec2Context, askOriginPort: '9443', askOriginProtocol: 'https-only',
    askOriginKeepaliveSeconds: '60', askCorsOrigins: 'https://a.example, https://b.example',
  })
  const origin = originById(t, behaviorFor(t, '/api/i595/ask*')!.TargetOriginId)
  assert.equal(origin.CustomOriginConfig.OriginProtocolPolicy, 'https-only')
  assert.equal(origin.CustomOriginConfig.HTTPSPort, 9443)
  assert.equal(origin.CustomOriginConfig.OriginKeepaliveTimeout, 60)
  t.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
    ResponseHeadersPolicyConfig: Match.objectLike({
      CorsConfig: Match.objectLike({ AccessControlAllowOrigins: { Items: ['https://a.example', 'https://b.example'] } }),
    }),
  })
})

test('unsafe or broken flag combinations are refused', () => {
  assert.throws(() => synth({ retireAskLambda: 'true' }), /needs askOrigin/)
  assert.throws(() => synth({ askOrigin: EC2_HOST }), /askEdgeKeyParam/)
  assert.throws(() => synth({ ...ec2Context, askOrigin: 'http://' + EC2_HOST }), /DNS name/)
  assert.throws(() => synth({ ...ec2Context, askOrigin: '34.237.187.140' }), /DNS name/)
  assert.throws(() => synth({ ...ec2Context, askOriginPort: '22' }), /askOriginPort/)
  assert.throws(() => synth({ ...ec2Context, askOriginProtocol: 'match-viewer' }), /askOriginProtocol/)
  assert.throws(() => synth({ ...ec2Context, askOriginKeepaliveSeconds: '61' }), /askOriginKeepaliveSeconds/)
  assert.throws(() => synth({ ...ec2Context, retireAskLambda: 'yes' }), /retireAskLambda/)
})
