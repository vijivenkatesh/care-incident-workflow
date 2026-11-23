import { CfnResource, IAspect } from 'aws-cdk-lib';
import { IConstruct } from 'constructs';

type Skips = Record<string, string>;

/**
 * Records a checkov suppression, with its justification, in the resource's
 * CloudFormation metadata. Checkov reads `Metadata.checkov.skip`, so every
 * exception is visible in code review and in the synthesized template.
 */
export function skipCheckov(construct: IConstruct, skips: Skips): void {
  const resource = (construct instanceof CfnResource ? construct : construct.node.defaultChild) as CfnResource | undefined;
  if (!resource) return;
  const existing = (resource.getMetadata('checkov') as { skip?: { id: string; comment: string }[] } | undefined)?.skip ?? [];
  const ids = new Set(existing.map((s) => s.id));
  const added = Object.entries(skips).filter(([id]) => !ids.has(id)).map(([id, comment]) => ({ id, comment }));
  resource.addMetadata('checkov', { skip: [...existing, ...added] });
}

/**
 * Accepted risks that apply to every resource of a type, including those CDK creates
 * internally (for example the log groups of its custom-resource Lambdas). Each one is
 * already encrypted with an AWS-managed key; the check only asks for a customer-managed key.
 */
const BY_TYPE: Record<string, Skips> = {
  'AWS::SQS::Queue': {
    CKV_AWS_27: 'Encrypted at rest with SSE-SQS (SQS-managed keys); checkov only recognises KMS keys',
  },
  'AWS::Logs::LogGroup': {
    CKV_AWS_158: 'CloudWatch Logs encrypts all log data at rest by default; a CMK is not required for this demo',
  },
  'AWS::SecretsManager::Secret': {
    CKV_AWS_149: 'Encrypted with the AWS-managed aws/secretsmanager key; a CMK adds cost without a cross-account need',
  },
};

/**
 * Deploy-time helpers that CDK creates and configures itself (S3 asset copy and
 * auto-delete of the site bucket). They only run during `cdk deploy`/`destroy`, hold no
 * application data, and their settings aren't exposed by the constructs.
 */
const CDK_INTERNAL = /\/Custom::(CDKBucketDeployment|S3AutoDeleteObjectsCustomResourceProvider)/;
const CDK_INTERNAL_SKIPS: Record<string, Skips> = {
  'AWS::Lambda::Function': {
    CKV_AWS_115: 'CDK-managed deploy-time custom resource handler; runs only during stack deployment',
    CKV_AWS_116: 'Invoked synchronously by CloudFormation, which reports failures itself; a DLQ never receives events',
    CKV_AWS_117: 'CDK-managed deploy-time handler that calls S3/CloudFront APIs only; no access to the application VPC needed',
    CKV_AWS_173: 'Environment holds no secrets, only CDK configuration; encrypted with the AWS-managed Lambda key',
  },
  'AWS::IAM::Policy': {
    CKV_AWS_111: 'CDK BucketDeployment role: cloudfront:CreateInvalidation does not support resource-level scoping here',
  },
};

export class CheckovSuppressions implements IAspect {
  visit(node: IConstruct): void {
    if (!(node instanceof CfnResource)) return;
    const type = node.cfnResourceType;
    if (BY_TYPE[type]) skipCheckov(node, BY_TYPE[type]);
    if (CDK_INTERNAL_SKIPS[type] && CDK_INTERNAL.test(node.node.path)) skipCheckov(node, CDK_INTERNAL_SKIPS[type]);
  }
}
