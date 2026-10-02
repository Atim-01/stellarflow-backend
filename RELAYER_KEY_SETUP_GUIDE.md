# Quick Setup Guide: Relayer Key Encryption 🚀

This guide walks you through setting up KMS envelope encryption for relayer private keys.

## Prerequisites

- AWS Account with KMS access
- PostgreSQL database
- Node.js 18+ and npm
- Admin API key for backend

## Step 1: Create KMS Key in AWS

```bash
# Create encryption key
aws kms create-key \
  --description "StellarFlow Relayer Envelope Encryption" \
  --key-usage ENCRYPT_DECRYPT

# Note the KeyId from output, then create alias
aws kms create-alias \
  --alias-name alias/stellarflow-relayer-envelope \
  --target-key-id <YOUR_KEY_ID>

# Get the ARN for environment configuration
aws kms describe-key --key-id alias/stellarflow-relayer-envelope
```

## Step 2: Configure IAM Permissions

Create or update IAM policy for your application:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "kms:GenerateDataKey",
        "kms:Decrypt"
      ],
      "Resource": "arn:aws:kms:us-east-1:YOUR_ACCOUNT:key/*"
    }
  ]
}
```

Attach this policy to:
- EC2 instance role (if running on EC2)
- ECS task role (if running on ECS)
- User credentials (for local development)

## Step 3: Set Environment Variables

Add to your `.env` file:

```bash
# KMS Configuration
KMS_ENVELOPE_KEY_ID=arn:aws:kms:us-east-1:123456789012:key/your-key-id
AWS_REGION=us-east-1

# AWS Credentials (if not using IAM role)
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
```

## Step 4: Run Database Migration

```bash
# Generate Prisma client
npm run db:generate

# Run migration
npm run db:migrate

# Verify migration succeeded
npm run verify:keys
```

Expected output:
```
✅ VERIFICATION PASSED
All private keys are properly encrypted.
Database dumps will contain ZERO unencrypted keys.
```

## Step 5: Generate Keys for Existing Relayers

Use the admin API to generate Ed25519 key pairs for your relayers:

```bash
# Generate key for relayer ID 1
curl -X POST http://localhost:3000/api/admin/relayers/1/keys \
  -H "X-Admin-Key: your-admin-key-here"

# Generate keys for all relayers (bash script)
for id in 1 2 3 4 5; do
  echo "Generating key for relayer $id..."
  curl -X POST http://localhost:3000/api/admin/relayers/$id/keys \
    -H "X-Admin-Key: your-admin-key-here"
  sleep 1
done
```

## Step 6: Verify Encryption

Check that all keys are properly encrypted:

```bash
# Run verification script
npm run verify:keys

# Check rotation statistics
curl http://localhost:3000/api/admin/relayers/keys/rotation-stats \
  -H "X-Admin-Key: your-admin-key-here"

# List all relayer keys
curl http://localhost:3000/api/admin/relayers/keys \
  -H "X-Admin-Key: your-admin-key-here"
```

## Step 7: Test Key Usage

Validate that a key can be decrypted and used:

```bash
# Validate encrypted key for relayer ID 1
curl -X POST http://localhost:3000/api/admin/relayers/1/keys/validate \
  -H "X-Admin-Key: your-admin-key-here"
```

Expected response:
```json
{
  "success": true,
  "message": "Key validation successful",
  "data": {
    "relayerId": 1,
    "isValid": true
  }
}
```

## Step 8: Monitor DEK Rotation

The DEK rotation job runs automatically at 2:00 AM UTC daily. Monitor it:

```bash
# Check rotation statistics
curl http://localhost:3000/api/admin/relayers/keys/rotation-stats \
  -H "X-Admin-Key: your-admin-key-here"

# Trigger manual test rotation (dry run)
curl -X POST "http://localhost:3000/api/admin/relayers/keys/rotate-deks?dryRun=true" \
  -H "X-Admin-Key: your-admin-key-here"
```

## Production Checklist ✅

Before deploying to production, verify:

- [ ] KMS key created and permissions configured
- [ ] `KMS_ENVELOPE_KEY_ID` environment variable set
- [ ] Database migration completed successfully
- [ ] All relayers have encrypted keys generated
- [ ] Verification script passes (`npm run verify:keys`)
- [ ] Test key validation succeeds
- [ ] DEK rotation job scheduled and running
- [ ] CloudWatch alarms configured for KMS errors
- [ ] Database backups encrypted
- [ ] Audit logging enabled

## Troubleshooting

### "KMS_ENVELOPE_KEY_ID environment variable is required"

**Solution:** Set the environment variable with your KMS key ARN:
```bash
export KMS_ENVELOPE_KEY_ID=arn:aws:kms:us-east-1:123456789012:key/your-key-id
```

### "Failed to generate data key: AccessDeniedException"

**Solution:** Check IAM permissions. Your application needs `kms:GenerateDataKey` and `kms:Decrypt` permissions.

### "Migration failed: column already exists"

**Solution:** The columns may have been added manually. Drop them first:
```sql
ALTER TABLE "Relayer" 
  DROP COLUMN IF EXISTS "publicKey",
  DROP COLUMN IF EXISTS "encryptedPrivateKey",
  DROP COLUMN IF EXISTS "encryptedDek",
  DROP COLUMN IF EXISTS "dekVersion",
  DROP COLUMN IF EXISTS "dekEncryptedAt",
  DROP COLUMN IF EXISTS "dekRotationScheduledAt",
  DROP COLUMN IF EXISTS "keyGeneratedAt";
```
Then re-run the migration.

### Verification fails with "plaintext keys detected"

**Solution:** 
1. Identify which relayers have plaintext keys (check logs)
2. Delete the plaintext keys from database
3. Regenerate keys using the API endpoint with proper encryption

## Next Steps

1. **Set up monitoring:** Configure CloudWatch alarms for KMS API errors and rotation failures
2. **Document procedures:** Update runbooks with key rotation and recovery procedures
3. **Test disaster recovery:** Verify backup/restore procedures work with encrypted keys
4. **Security audit:** Review IAM policies and access logs

## Support

- **Documentation:** See `RELAYER_KEY_ENCRYPTION.md` for detailed information
- **Verification:** Run `npm run verify:keys` anytime
- **Logs:** Check application logs for key operation audit trail
- **CloudTrail:** Review KMS API calls in AWS CloudTrail

---

**Setup Time:** ~15 minutes  
**Difficulty:** Intermediate  
**Status:** Production Ready ✅
