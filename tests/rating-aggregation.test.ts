import { displayRating, isAggregateContributor } from '../src/services/ratingAggregationService';
import { providerResponseNeedsModeration, responseModerationTransition } from '../src/services/providerReputationService';

describe('canonical review and rating policy', () => {
  test('uses an honest empty state and one-decimal display rule', () => {
    expect(displayRating(0, 0)).toBeNull();
    expect(displayRating('4.46', 3)).toBe(4.5);
  });

  test('keeps reports neutral until moderation decides', () => {
    expect(isAggregateContributor('PUBLISHED', 'REPORTED')).toBe(true);
    expect(isAggregateContributor('REMOVED', 'REMOVED')).toBe(false);
    expect(isAggregateContributor('PENDING_MODERATION', 'PENDING')).toBe(false);
  });

  test('moderates off-platform contact or payment signals in responses', () => {
    expect(providerResponseNeedsModeration('Please pay my GCash account')).toBe(true);
    expect(providerResponseNeedsModeration('Thank you for your feedback.')).toBe(false);
  });

  test('response decisions control only the provider response lifecycle', () => {
    expect(responseModerationTransition('approve')).toEqual({
      caseState: 'APPROVED', moderation: 'APPROVED', publication: 'PUBLISHED',
    });
    expect(responseModerationTransition('reject')).toEqual({
      caseState: 'REJECTED', moderation: 'REJECTED', publication: 'REJECTED',
    });
    expect(responseModerationTransition('request_information')?.publication).toBe('PENDING_MODERATION');
    expect(responseModerationTransition('unknown')).toBeNull();
  });
});
