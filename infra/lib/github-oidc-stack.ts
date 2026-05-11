import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

const GITHUB_OIDC_ISSUER_URL = 'https://token.actions.githubusercontent.com';
const GITHUB_OIDC_AUDIENCE = 'sts.amazonaws.com';
const MAX_DEPLOY_SESSION_DURATION = cdk.Duration.hours(1);
const DEPLOY_ROLE_NAME = 'saahil.io-github-deploy';

export interface GithubOidcStackProps extends cdk.StackProps {
  readonly githubOwner: string;
  readonly githubRepos: readonly string[];
  readonly siteBucketArn: string;
  readonly distributionId: string;
}

export class GithubOidcStack extends cdk.Stack {
  public readonly deployRoleArn: string;

  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, props);

    if (props.githubRepos.length === 0) {
      throw new Error('githubRepos must contain at least one repository name.');
    }

    const provider = this.createOidcProvider();
    const trustPrincipal = this.buildTrustPrincipal(
      provider,
      props.githubOwner,
      props.githubRepos,
    );
    const deployRole = this.createDeployRole(trustPrincipal, props);

    this.attachSiteBucketPermissions(deployRole, props.siteBucketArn);
    this.attachCloudFrontInvalidationPermission(
      deployRole,
      props.distributionId,
    );

    this.deployRoleArn = deployRole.roleArn;
    this.publishOutputs(deployRole);
  }

  private createOidcProvider(): iam.OpenIdConnectProvider {
    return new iam.OpenIdConnectProvider(this, 'GithubOidcProvider', {
      url: GITHUB_OIDC_ISSUER_URL,
      clientIds: [GITHUB_OIDC_AUDIENCE],
    });
  }

  // Trust scope: any ref in any of the configured repos. Tighten the StringLike
  // sub patterns to e.g. `repo:owner/repo:ref:refs/heads/main` to restrict
  // deploys to a single branch once each workflow is stable.
  private buildTrustPrincipal(
    provider: iam.IOpenIdConnectProvider,
    githubOwner: string,
    githubRepos: readonly string[],
  ): iam.IPrincipal {
    const repoSubjectPatterns = githubRepos.map(
      (repo) => `repo:${githubOwner}/${repo}:*`,
    );
    return new iam.OpenIdConnectPrincipal(provider).withConditions({
      StringEquals: {
        'token.actions.githubusercontent.com:aud': GITHUB_OIDC_AUDIENCE,
      },
      StringLike: {
        'token.actions.githubusercontent.com:sub': repoSubjectPatterns,
      },
    });
  }

  private createDeployRole(
    principal: iam.IPrincipal,
    props: GithubOidcStackProps,
  ): iam.Role {
    const trustedRepos = props.githubRepos
      .map((repo) => `${props.githubOwner}/${repo}`)
      .join(', ');
    return new iam.Role(this, 'GithubDeployRole', {
      roleName: DEPLOY_ROLE_NAME,
      assumedBy: principal,
      description: `GitHub Actions deploy role for ${trustedRepos}.`,
      maxSessionDuration: MAX_DEPLOY_SESSION_DURATION,
    });
  }

  private attachSiteBucketPermissions(
    role: iam.Role,
    bucketArn: string,
  ): void {
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SiteBucketReadWrite',
        effect: iam.Effect.ALLOW,
        actions: ['s3:ListBucket', 's3:GetBucketLocation'],
        resources: [bucketArn],
      }),
    );

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SiteBucketObjects',
        effect: iam.Effect.ALLOW,
        actions: [
          's3:PutObject',
          's3:PutObjectAcl',
          's3:GetObject',
          's3:DeleteObject',
        ],
        resources: [`${bucketArn}/*`],
      }),
    );
  }

  private attachCloudFrontInvalidationPermission(
    role: iam.Role,
    distributionId: string,
  ): void {
    const distributionArn = `arn:aws:cloudfront::${this.account}:distribution/${distributionId}`;

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudFrontInvalidate',
        effect: iam.Effect.ALLOW,
        actions: [
          'cloudfront:CreateInvalidation',
          'cloudfront:GetInvalidation',
          'cloudfront:ListInvalidations',
        ],
        resources: [distributionArn],
      }),
    );
  }

  private publishOutputs(deployRole: iam.Role): void {
    new cdk.CfnOutput(this, 'DeployRoleArn', {
      value: deployRole.roleArn,
      description:
        'IAM role ARN for GitHub Actions to assume via OIDC. Shared by all trusted repos.',
      exportName: 'SaahilSite-DeployRoleArn',
    });
  }
}
