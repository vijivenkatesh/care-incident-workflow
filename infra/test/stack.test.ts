import { App, Aspects } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { IncidentWorkflowStack } from '../lib/incident-workflow-stack';
import { NoWildcardActions } from '../lib/guardrails';

const app = new App();
const stack = new IncidentWorkflowStack(app, 'Test', { env: { account: '123456789012', region: 'ap-southeast-2' } });
Aspects.of(stack).add(new NoWildcardActions());
const template = Template.fromStack(stack);

test('no guardrail errors (no "*" IAM actions)', () => {
  expect(Annotations.fromStack(stack).findError('*', Match.anyValue())).toHaveLength(0);
});

test('every Lambda runs in the VPC with tracing', () => {
  const fns = template.findResources('AWS::Lambda::Function', {
    Properties: { Runtime: 'python3.12' },
  });
  expect(Object.keys(fns)).toHaveLength(4);
  for (const f of Object.values<any>(fns)) {
    expect(f.Properties.VpcConfig).toBeDefined();
    expect(f.Properties.TracingConfig).toEqual({ Mode: 'Active' });
  }
});

test('VPC has no NAT or internet gateway', () => {
  template.resourceCountIs('AWS::EC2::NatGateway', 0);
  template.resourceCountIs('AWS::EC2::InternetGateway', 0);
});

test('public API comes from the OpenAPI contract with a Cognito authorizer', () => {
  template.hasResourceProperties('AWS::ApiGateway::RestApi', {
    Body: Match.objectLike({
      openapi: '3.0.1',
      components: Match.objectLike({
        securitySchemes: { CognitoJwt: Match.objectLike({ 'x-amazon-apigateway-authtype': 'cognito_user_pools' }) },
      }),
      'x-amazon-apigateway-request-validator': 'all',
    }),
  });
});

test('internal API is PRIVATE and IAM-authorized', () => {
  template.hasResourceProperties('AWS::ApiGateway::RestApi', {
    EndpointConfiguration: { Types: ['PRIVATE'], VpcEndpointIds: Match.anyValue() },
  });
  template.hasResourceProperties('AWS::ApiGateway::Method', { HttpMethod: 'GET', AuthorizationType: 'AWS_IAM' });
});

test('every work queue has a dead-letter queue and alarm', () => {
  const queues = template.findResources('AWS::SQS::Queue', { Properties: { RedrivePolicy: Match.anyValue() } });
  expect(Object.keys(queues)).toHaveLength(2);
  template.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmDescription: 'Audit events failed processing' });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmDescription: 'Regulator submissions failed: incidents not reported',
  });
});

test('EventBridge routes REPORTED incidents to the regulator queue', () => {
  template.hasResourceProperties('AWS::Events::Rule', {
    EventPattern: { source: ['care.incidents'], 'detail-type': ['IncidentStatusChanged'], detail: { status: ['REPORTED'] } },
  });
});

test('Cognito has the three workflow role groups', () => {
  for (const g of ['staff', 'supervisor', 'compliance']) {
    template.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: g });
  }
});
