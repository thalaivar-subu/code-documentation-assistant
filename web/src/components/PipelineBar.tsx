import { Fragment } from 'react';

export type StageStatus = 'pending' | 'active' | 'done' | 'insufficient';

export interface PipelineStageView {
  id: string;
  title: string;
  status: StageStatus;
  /** Short live text shown under the stage while hovered/selected. */
  detail?: string;
}

/**
 * GitLab-MR-pipeline-style stage bar — spinner while running, checkmark on
 * done, loop icon when Grade sends the loop back to Retrieve. The same
 * component renders both the 4-stage ingest pipeline and the 8-stage query
 * pipeline, just fed different `stages` arrays.
 */
export function PipelineBar({
  stages,
  onSelect,
  selectedId,
}: {
  stages: PipelineStageView[];
  onSelect?: (id: string) => void;
  selectedId?: string;
}) {
  return (
    <div className="pipeline-bar" role="list">
      {stages.map((s, i) => (
        <Fragment key={s.id}>
          <button
            type="button"
            role="listitem"
            className={`stage stage-${s.status}${selectedId === s.id ? ' stage-selected' : ''}`}
            onClick={() => onSelect?.(s.id)}
            disabled={!onSelect}
          >
            <span className="stage-head">
              <span className="stage-icon" aria-hidden="true" />
              <span className="stage-title">{s.title}</span>
            </span>
            {s.detail && <span className="stage-detail">{s.detail}</span>}
          </button>
          {i < stages.length - 1 && (
            <span className="stage-arrow" aria-hidden="true">
              →
            </span>
          )}
        </Fragment>
      ))}
    </div>
  );
}
