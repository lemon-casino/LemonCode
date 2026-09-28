/*
 * Derived from vercel/ai-elements (skills/ai-elements/scripts/suggestion.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by LCode: local integration, formatting and adaptations.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
"use client";

import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";

const suggestions = [
  "What are the latest trends in AI?",
  "How does machine learning work?",
  "Explain quantum computing",
  "Best practices for React development",
  "Tell me about TypeScript benefits",
  "How to optimize database queries?",
  "What is the difference between SQL and NoSQL?",
  "Explain cloud computing basics",
];

const handleSuggestionClick = (suggestion: string) => {
  console.log("Selected suggestion:", suggestion);
};

const Example = () => (
  <Suggestions>
    {suggestions.map((suggestion) => (
      <Suggestion key={suggestion} onClick={handleSuggestionClick} suggestion={suggestion} />
    ))}
  </Suggestions>
);

export default Example;
