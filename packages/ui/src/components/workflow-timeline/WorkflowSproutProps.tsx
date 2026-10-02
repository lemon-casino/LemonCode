export function SproutKeyboard() {
  return (
    <g className="wf-sprout-keyboard" data-avatar-prop="keyboard">
      <path
        className="wf-sprout-keyboard-case"
        d="M19 78.5h58q3 0 4 3l5 9q1 3-3 3H13q-4 0-3-3l5-9q1-3 4-3Z"
      />
      <path className="wf-sprout-keyboard-edge" d="M12 91h72" />
      <g className="wf-sprout-keys">
        {[82, 86].map((y, row) =>
          Array.from({ length: 8 }, (_, col) => (
            <rect
              key={`${row}-${col}`}
              className={
                row === 0 && (col === 2 || col === 3)
                  ? "wf-sprout-key-active"
                  : row === 0 && (col === 5 || col === 6)
                    ? "wf-sprout-key-active wf-sprout-key-right"
                    : undefined
              }
              x={20 + col * 7.1 - row}
              y={y}
              width={5.4}
              height={2.5}
              rx={0.8}
            />
          )),
        )}
        <rect x={35} y={90} width={26} height={2.2} rx={1} />
      </g>
      <g className="wf-sprout-typing-hand">
        <path className="wf-sprout-arm" d="M23 65q1 9 12 12" />
        <ellipse cx={35} cy={77.5} rx={6} ry={3.5} />
      </g>
      <g className="wf-sprout-typing-hand wf-sprout-hand-right">
        <path className="wf-sprout-arm" d="M73 65q-1 9-12 12" />
        <ellipse cx={61} cy={77.5} rx={6} ry={3.5} />
      </g>
    </g>
  );
}

export function SproutRain() {
  return (
    <g className="wf-sprout-rain" data-avatar-prop="rain">
      <ellipse className="wf-sprout-puddle" cx={48} cy={89} rx={24} ry={2.8} />
      <g className="wf-sprout-rain-cloud">
        <path d="M21 21c-7 0-10-4-8-9 1-4 5-6 9-5 3-7 13-9 18-3 4-4 12-4 16 1 7-4 14-1 16 5 8-1 13 3 12 7-1 5-6 6-12 6H24q-2 0-3-2Z" />
        <path className="wf-sprout-shine" d="M22 11q4-4 9-3" />
      </g>
      <g className="wf-sprout-rain-drops">
        {[
          "m12 29-2 5",
          "m19 43-2 5",
          "m81 29-2 5",
          "m89 45-2 5",
          "m10 61-2 5",
          "m85 65-2 5",
          "m25 25-2 5",
          "m71 26-2 5",
        ].map((d) => (
          <path className="wf-sprout-rain-drop" key={d} d={d} />
        ))}
      </g>
    </g>
  );
}
