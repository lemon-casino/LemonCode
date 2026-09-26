import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RollingToolbarLabel } from "./RollingToolbarLabel.js";

for (const reducedMotion of [false, true]) {
  test(`provider and long model name share one row when reduced motion is ${reducedMotion}`, () => {
    const markup = renderToStaticMarkup(
      <RollingToolbarLabel
        label="OpenAI/a-very-long-model-name"
        prefix="OpenAI/"
        reducedMotionOverride={reducedMotion}
        value="a-very-long-model-name"
      />,
    );

    assert.match(
      markup,
      /<span(?=[^>]*data-toolbar-label-root="true")[^>]*><span(?=[^>]*data-toolbar-label-content="true")/,
    );
    assert.match(markup, /inline-flex/);
    assert.match(markup, /whitespace-nowrap/);
    assert.match(markup, /OpenAI\/<\/span><span>a-very-long-model-name/);
  });
}
