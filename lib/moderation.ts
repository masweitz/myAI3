import OpenAI from 'openai';
import {
    MODERATION_DENIAL_MESSAGE_SEXUAL,
    MODERATION_DENIAL_MESSAGE_SEXUAL_MINORS,
    MODERATION_DENIAL_MESSAGE_HARASSMENT,
    MODERATION_DENIAL_MESSAGE_HARASSMENT_THREATENING,
    MODERATION_DENIAL_MESSAGE_HATE,
    MODERATION_DENIAL_MESSAGE_HATE_THREATENING,
    MODERATION_DENIAL_MESSAGE_ILLICIT,
    MODERATION_DENIAL_MESSAGE_ILLICIT_VIOLENT,
    MODERATION_DENIAL_MESSAGE_SELF_HARM,
    MODERATION_DENIAL_MESSAGE_SELF_HARM_INTENT,
    MODERATION_DENIAL_MESSAGE_SELF_HARM_INSTRUCTIONS,
    MODERATION_DENIAL_MESSAGE_VIOLENCE,
    MODERATION_DENIAL_MESSAGE_VIOLENCE_GRAPHIC,
    MODERATION_DENIAL_MESSAGE_DEFAULT,
} from '@/config';

export interface ModerationResult {
    flagged: boolean;
    denialMessage?: string;
    category?: string;
    // When a violence flag is detected, these fields can indicate
    // whether the content may be allowed (e.g. military/academic),
    // whether it requires human review, and an optional note.
    allow?: boolean;
    note?: string;
}

const CATEGORY_DENIAL_MESSAGES: Record<string, string> = {
    'sexual': MODERATION_DENIAL_MESSAGE_SEXUAL,
    'sexual/minors': MODERATION_DENIAL_MESSAGE_SEXUAL_MINORS,
    'harassment': MODERATION_DENIAL_MESSAGE_HARASSMENT,
    'harassment/threatening': MODERATION_DENIAL_MESSAGE_HARASSMENT_THREATENING,
    'hate': MODERATION_DENIAL_MESSAGE_HATE,
    'hate/threatening': MODERATION_DENIAL_MESSAGE_HATE_THREATENING,
    'illicit': MODERATION_DENIAL_MESSAGE_ILLICIT,
    'illicit/violent': MODERATION_DENIAL_MESSAGE_ILLICIT_VIOLENT,
    'self-harm': MODERATION_DENIAL_MESSAGE_SELF_HARM,
    'self-harm/intent': MODERATION_DENIAL_MESSAGE_SELF_HARM_INTENT,
    'self-harm/instructions': MODERATION_DENIAL_MESSAGE_SELF_HARM_INSTRUCTIONS,
    'violence': MODERATION_DENIAL_MESSAGE_VIOLENCE,
    'violence/graphic': MODERATION_DENIAL_MESSAGE_VIOLENCE_GRAPHIC,
};

const CATEGORY_CHECK_ORDER: string[] = [
    'sexual/minors',
    'sexual',
    'harassment/threatening',
    'harassment',
    'hate/threatening',
    'hate',
    'illicit/violent',
    'illicit',
    'self-harm/instructions',
    'self-harm/intent',
    'self-harm',
    'violence/graphic',
    'violence',
];

// Simple deterministic classifier to distinguish military/academic
// discussion from malicious, actionable intent. This avoids extra
// LLM calls and provides a conservative default.
async function classifyViolenceIntent(text: string): Promise<{
    label: 'MILITARY_ACADEMIC' | 'MALICIOUS' | 'AMBIGUOUS';
    reason?: string;
}> {
    const t = (text || '').toLowerCase();

    const militaryKeywords = [
        'army', 'military', 'tactic', 'tactics', 'strategy', 'strategic',
        'warfare', 'doctrine', 'campaign', 'maneuver', 'logistics', 'historical', 'training',
        'attack', 'ambush', 'raid', 'contact', 'weapon', 'weapon system', 'movement to contact',
        'teach me', 'help me understand', 'explain', 'how to', 'how would i', 'what if i', 'historical example',
        'tell me', 'how do', 'what are', 'why do', 'when did', 'where did', 'who did', 'case study', 'analysis of',
    ];

    const maliciousKeywords = [
        'attack plan', 'assassin', 'assassinat',
        'bomb', 'detonate', 'weaponize', 'improvis', 'ied', 'sabotage', 'kill', 'murder'
    ];

    const hasMilitary = militaryKeywords.some(k => t.includes(k));
    const hasMalicious = maliciousKeywords.some(k => t.includes(k));

    if (hasMalicious) {
        return { label: 'MALICIOUS', reason: 'Contains clearly malicious keywords' };
    }

    if (hasMilitary && !hasMalicious) {
        return { label: 'MILITARY_ACADEMIC', reason: 'Contains military/academic keywords without malicious markers' };
    }

    return { label: 'AMBIGUOUS', reason: 'No clear classification from keywords' };
}

// Decide what to do for violence flags using the classifier.
export async function handleViolenceFlag(text: string) {
    const classification = await classifyViolenceIntent(text);

    if (classification.label === 'MILITARY_ACADEMIC') {
        // Allow but require human review and force sanitization on responses.
        return { allow: true, note: 'military_academic' };
    }

    if (classification.label === 'MALICIOUS') {
        // Deny outright.
        return { allow: false, note: 'malicious' };
    }

    // Ambiguous content should be reviewed by a human.
    return { allow: false, note: 'ambiguous' };
}

export async function isContentFlagged(text: string): Promise<ModerationResult> {
    if (!text || text.trim().length === 0) {
        return { flagged: false };
    }

    const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
    });

    try {
        const moderationResult = await openai.moderations.create({
            input: text,
        });

        const result = moderationResult.results[0];
        if (!result?.flagged) {
            return { flagged: false };
        }

        const categories = result.categories;
        for (const category of CATEGORY_CHECK_ORDER) {
            if (categories[category as keyof typeof categories] === true) {
                // Special handling for violence flags: classify intent
                if (category.startsWith('violence')) {
                    const decision = await handleViolenceFlag(text);
                    if (decision.allow) {
                        return {
                            flagged: false,
                            category,
                            allow: true,
                            note: decision.note,
                        };
                    }

                    return {
                        flagged: true,
                        category,
                        denialMessage: CATEGORY_DENIAL_MESSAGES[category] || MODERATION_DENIAL_MESSAGE_DEFAULT,
                        note: decision.note,
                    };
                }

                return {
                    flagged: true,
                    category,
                    denialMessage: CATEGORY_DENIAL_MESSAGES[category] || MODERATION_DENIAL_MESSAGE_DEFAULT,
                };
            }
        }

        return {
            flagged: true,
            denialMessage: MODERATION_DENIAL_MESSAGE_DEFAULT,
        };
    } catch (error) {
        return { flagged: false };
    }
}

