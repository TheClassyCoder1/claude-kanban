import {
  countChanges,
  deriveStatus,
  STATUS_META,
  type FeatureRecord,
} from "@/lib/featureTypes";
import { formatDate, formatTokens, formatUsd, shortModel } from "@/lib/format";

function TokenStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded bg-slate-50 px-2 py-1">
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className="text-sm font-medium text-slate-700">{formatTokens(value)}</div>
    </div>
  );
}

export default function FeatureItem({ record }: { record: FeatureRecord }) {
  const status = deriveStatus(record);
  const meta = STATUS_META[status];
  const changes = countChanges(record);

  // Headline: the Claude summary when done, else the first prompt, else project+date.
  const headline =
    (status === "done" && record.summaryHeadline?.trim()) ||
    record.userPrompts[0] ||
    `${record.projectName} — ${formatDate(record.endedAt)}`;

  const areas = Object.entries(record.filesByArea);
  const narrativeBody = record.summary.split("\n").slice(1).join("\n").trim();

  return (
    <details className="group rounded-lg border border-slate-200 bg-white shadow-sm open:shadow">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold ${meta.badge}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
              {meta.label}
            </span>
            <p className="min-w-0 truncate text-sm font-semibold text-slate-800">{headline}</p>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {record.projectName} · {formatDate(record.endedAt)} · {shortModel(record.model)} ·{" "}
            {record.turns} iterations · {changes} changes
            {record.summarySource === "heuristic" && (
              <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">
                heuristic
              </span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-right sm:gap-4">
          <div className="hidden sm:block">
            <div className="text-[10px] uppercase tracking-wide text-slate-400">out</div>
            <div className="text-sm font-medium text-slate-700">
              {formatTokens(record.tokens.output)}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-slate-400">est. cost</div>
            <div className="text-sm font-semibold text-emerald-700">
              {formatUsd(record.estimatedCostUsd)}
            </div>
          </div>
          <span className="text-slate-300 transition-transform group-open:rotate-90">▶</span>
        </div>
      </summary>

      <div className="border-t border-slate-100 p-4 pt-3">
        <p className="mb-3 text-xs italic text-slate-400">{meta.description}</p>

        {status === "done" && narrativeBody ? (
          <p className="mb-4 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
            {narrativeBody}
          </p>
        ) : status !== "done" ? (
          <p className="mb-4 text-sm text-slate-600">
            {changes > 0
              ? `${changes} file change(s) so far across ${areas.length} area(s). A summary is written when the session ends.`
              : "No changes captured yet."}
          </p>
        ) : null}

        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
          <TokenStat label="input" value={record.tokens.input} />
          <TokenStat label="output" value={record.tokens.output} />
          <TokenStat label="cache read" value={record.tokens.cacheRead} />
          <TokenStat label="cache write" value={record.tokens.cacheCreation} />
          <div className="rounded bg-emerald-50 px-2 py-1">
            <div className="text-[10px] uppercase tracking-wide text-emerald-500">est. cost</div>
            <div className="text-sm font-semibold text-emerald-700">
              {formatUsd(record.estimatedCostUsd)}
            </div>
          </div>
        </div>

        {record.summaryCostUsd != null && (
          <p className="mb-4 text-[11px] text-slate-400">
            Summary call (the one real LLM request): actual{" "}
            <span className="font-medium text-slate-500">{formatUsd(record.summaryCostUsd)}</span> —
            session token cost above is estimated.
          </p>
        )}

        {areas.length > 0 && (
          <div className="mb-4">
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
              Changes
            </h4>
            <div className="space-y-2">
              {areas.map(([area, f]) => (
                <div key={area} className="text-xs">
                  <span className="font-medium text-slate-600">{area}</span>
                  {f.created.length > 0 && (
                    <span className="text-slate-500"> — created {f.created.join(", ")}</span>
                  )}
                  {f.edited.length > 0 && (
                    <span className="text-slate-500"> — edited {f.edited.join(", ")}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {record.commands.length > 0 && (
          <div className="mb-4">
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
              Key commands
            </h4>
            <ul className="space-y-0.5">
              {record.commands.map((c, i) => (
                <li key={i} className="truncate font-mono text-[11px] text-slate-500">
                  {c}
                </li>
              ))}
            </ul>
          </div>
        )}

        {record.userPrompts.length > 0 && (
          <div>
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
              Prompts
            </h4>
            <ul className="space-y-0.5">
              {record.userPrompts.map((p, i) => (
                <li key={i} className="truncate text-[11px] text-slate-500">
                  “{p}”
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}
