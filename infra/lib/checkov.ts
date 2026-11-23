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

export class CheckovSuppressions implements IAspect {
  visit(node: IConstruct): void {
    if (node instanceof CfnResource && BY_TYPE[node.cfnResourceType]) {
      skipCheckov(node, BY_TYPE[node.cfnResourceType]);
    }
  }
}
