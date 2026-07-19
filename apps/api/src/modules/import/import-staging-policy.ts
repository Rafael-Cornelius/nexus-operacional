import { ImportReviewDecision, ImportStagingClassification, ImportStagingDomain, Prisma } from "@prisma/client";

const promotableDomains = new Set<ImportStagingDomain>([
  ImportStagingDomain.PRODUCT,
  ImportStagingDomain.PRODUCTION,
  ImportStagingDomain.LOSS,
  ImportStagingDomain.DOWNTIME
]);

interface PromotionCandidate {
  domain: ImportStagingDomain;
  classification: ImportStagingClassification;
  decision: ImportReviewDecision;
}

export function isPromotionBlocker(record: PromotionCandidate) {
  if (record.decision === ImportReviewDecision.IGNORED || record.decision === ImportReviewDecision.REJECTED) return false;
  if (!promotableDomains.has(record.domain)) return true;
  if (record.decision === ImportReviewDecision.CORRECTED) {
    return record.classification !== ImportStagingClassification.VALID;
  }
  if (record.classification === ImportStagingClassification.VALID) return false;
  if (record.classification === ImportStagingClassification.WARNING || record.classification === ImportStagingClassification.REQUIRES_REVIEW) {
    return record.decision !== ImportReviewDecision.APPROVED;
  }
  return true;
}

export function promotionBlockerWhere(batchId: string): Prisma.ImportStagingRecordWhereInput {
  return {
    batchId,
    decision: { notIn: [ImportReviewDecision.IGNORED, ImportReviewDecision.REJECTED] },
    OR: [
      { domain: { notIn: [...promotableDomains] } },
      { classification: { in: [ImportStagingClassification.ERROR, ImportStagingClassification.DUPLICATE] } },
      {
        classification: { in: [ImportStagingClassification.WARNING, ImportStagingClassification.REQUIRES_REVIEW] },
        decision: { not: ImportReviewDecision.APPROVED }
      }
    ]
  };
}
