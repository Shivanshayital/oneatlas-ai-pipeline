export interface PromptAnalysis {
  clarificationRequired: boolean;
  clarificationQuestion?: string;
  assumptions: string[];
  scopeRecommendations: string[];
}

const ambiguityPatterns: Array<{ regex: RegExp; question: string }> = [
  {
    regex: /\ban app\b|\bapp\.?$/i,
    question: "What is the core business outcome and primary user for this application?",
  },
  {
    regex: /\bmake it smart\b|\bsmart\b|\bintelligent\b|\bautomate\b/i,
    question: "Which tasks should the app automate versus keep as manual workflows?",
  },
  {
    regex: /\bCRM\b|\bproject manager\b|\binvoicing\b|\benterprise\b/i,
    question: "Which feature set should be first in the MVP?",
  },
];

const scopeReductionPatterns: Array<{ regex: RegExp; advice: string }> = [
  {
    regex: /CRM\s*\+|project manager\s*\+|\binvoicing\b/i,
    advice: "Focus on the primary workflow and defer secondary domains to a later MVP.",
  },
  {
    regex: /\benterprise\b|\bglobal\b|\bscale\b|\blarge\s*team\b/i,
    advice: "Target a single team or department first, then expand in later versions.",
  },
];

export function analyzePrompt(prompt: string): PromptAnalysis {
  const normalized = prompt.trim();
  const assumptions: string[] = [];
  const scopeRecommendations: string[] = [];
  let clarificationRequired = false;
  let clarificationQuestion: string | undefined;

  for (const pattern of ambiguityPatterns) {
    if (pattern.regex.test(normalized)) {
      clarificationRequired = true;
      clarificationQuestion = clarificationQuestion || pattern.question;
    }
  }

  for (const pattern of scopeReductionPatterns) {
    if (pattern.regex.test(normalized)) {
      scopeRecommendations.push(pattern.advice);
    }
  }

  if (/\bmake it smart\b|\bsmart\b|\bintelligent\b|\bautomate\b/i.test(normalized)) {
    assumptions.push(
      "The application should include AI-driven suggestions and automated decision support for routine actions."
    );
  }


  if (/\benterprise\b|\bglobal\b|\bscale\b|\blarge\s*team\b/i.test(normalized)) {
    assumptions.push(
      "Begin with an MVP for a single product team, with enterprise requirements deferred."
    );
  }

  if (/\bambiguou?s\b|\bseveral\b|\bbroad\b|\bcomplex\b/i.test(normalized)) {
    clarificationRequired = true;
    clarificationQuestion =
      clarificationQuestion ||
      "Can you narrow the business goal or the primary user persona for the application?";
  }

  if (normalized.length < 20) {
    clarificationRequired = true;
    clarificationQuestion =
      clarificationQuestion ||
      "Please provide more detail so the pipeline can generate a coherent app specification.";
  }

  return {
    clarificationRequired,
    clarificationQuestion,
    assumptions,
    scopeRecommendations,
  };
}
