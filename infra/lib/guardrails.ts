import { Annotations, IAspect, Stack } from 'aws-cdk-lib';
import { CfnPolicy } from 'aws-cdk-lib/aws-iam';
import { IConstruct } from 'constructs';

/**
 * Synth-time guardrail: fails `cdk synth` if any inline IAM policy grants a
 * bare "*" action (e.g. "s3:*" is allowed by CDK grants for some services,
 * but "*" alone never is). Runs in CI before anything is deployed.
 */
export class NoWildcardActions implements IAspect {
  visit(node: IConstruct): void {
    if (!(node instanceof CfnPolicy)) return;
    const doc = Stack.of(node).resolve(node.policyDocument) as { Statement?: { Action?: string | string[] }[] };
    for (const statement of doc.Statement ?? []) {
      const actions = ([] as string[]).concat(statement.Action ?? []);
      if (actions.includes('*')) {
        Annotations.of(node).addError('IAM policy grants Action "*"; use least-privilege actions');
      }
    }
  }
}
