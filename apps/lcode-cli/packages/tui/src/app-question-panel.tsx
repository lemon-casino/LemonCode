import React from "react";
import type { QuestionPromptState } from "./app-model.js";
import { palette } from "./app-model.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

export function QuestionPanel({ state }: { state: QuestionPromptState }): React.ReactElement {
  if (state.reviewing) {
    return h(
      "box",
      {
        title: "Review answers",
        style: questionPanelStyle(),
      },
      ...state.input.questions.map((question) =>
        h(
          "text",
          { key: question.question, style: { fg: palette.text } },
          `${question.header}: ${state.answers[question.question] ?? "(not answered)"}`,
        ),
      ),
      h("text", { style: { fg: palette.muted } }, "Enter submits, Tab edits, Esc declines"),
    );
  }

  const question = state.input.questions[state.currentQuestionIndex];
  if (!question) {
    return h("box", { style: questionPanelStyle() });
  }

  if (state.editingOther) {
    return h(
      "box",
      {
        title: `Question ${state.currentQuestionIndex + 1}/${state.input.questions.length}: ${question.header}`,
        style: questionPanelStyle(),
      },
      h("text", { style: { fg: palette.text } }, question.question),
      h("text", { style: { fg: palette.accent } }, `Other: ${state.otherBuffer}`),
      h(
        "text",
        { style: { fg: palette.muted } },
        "Type custom answer. Enter accepts, Esc cancels.",
      ),
    );
  }

  const otherIndex = question.options.length;
  const otherValue = state.otherText[question.question];
  const selectedLabels = new Set(state.multiSelections[question.question] ?? []);
  const rows = [
    ...question.options.map((option, index) => ({
      description: option.description,
      label: option.label,
      selected: question.multiSelect
        ? selectedLabels.has(option.label)
        : state.selectedOptionIndex === index,
    })),
    {
      description: otherValue ?? "Type a custom answer",
      label: "Other",
      selected: question.multiSelect
        ? Boolean(otherValue && selectedLabels.has("Other"))
        : state.selectedOptionIndex === otherIndex,
    },
  ];

  return h(
    "box",
    {
      title: `Question ${state.currentQuestionIndex + 1}/${state.input.questions.length}: ${question.header}`,
      style: questionPanelStyle(),
    },
    h("text", { style: { fg: palette.text } }, question.question),
    ...rows.map((row, index) =>
      h(
        "text",
        {
          key: row.label,
          style: {
            fg: state.selectedOptionIndex === index ? palette.accent : palette.text,
          },
        },
        `${state.selectedOptionIndex === index ? ">" : " "} ${
          question.multiSelect ? (row.selected ? "[x]" : "[ ]") : row.selected ? "(*)" : "( )"
        } ${row.label} - ${row.description}`,
      ),
    ),
    h(
      "text",
      { style: { fg: palette.muted } },
      question.multiSelect
        ? "Space toggles, Enter reviews, s skips, o edits Other, Esc declines"
        : "Enter answers, s skips, o edits Other, Esc declines",
    ),
  );
}

function questionPanelStyle(): Record<string, unknown> {
  return {
    backgroundColor: palette.panel,
    border: true,
    borderColor: palette.warning,
    flexDirection: "column",
    height: 10,
    marginBottom: 1,
    padding: 1,
  };
}
