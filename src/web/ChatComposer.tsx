import type { ChangeEventHandler, FormEventHandler } from 'react';
import { Link } from 'react-router';
import type { SourceSelection } from '../shared/api';
import { ModelPicker } from './ModelPicker';
import type { ModelRoute } from './ModelPicker';

interface ChatComposerProps {
  readonly projectId: string;
  readonly selection: SourceSelection;
  readonly scopeSummary: string;
  readonly modelSummary: string;
  readonly models: readonly ModelRoute[];
  readonly modelRoute: string;
  readonly onModelRouteChange: (route: string) => void;
  readonly inheritedModel: string;
  readonly modelsLoading: boolean;
  readonly modelsError: string;
  readonly modelsWarnings: readonly string[];
  readonly onModelSelectionPendingChange: (pending: boolean) => void;
  readonly controlsExpanded: boolean;
  readonly controlsId: string;
  readonly onToggleControls: () => void;
  readonly onFocusControls: () => void;
  readonly showLatest: boolean;
  readonly hasTurns: boolean;
  readonly onJumpToLatest: () => void;
  readonly question: string;
  readonly onQuestionChange: ChangeEventHandler<HTMLTextAreaElement>;
  readonly onSubmit: FormEventHandler<HTMLFormElement>;
  readonly sendDisabled: boolean;
  readonly busy: boolean;
  readonly queuedQuestion: string | null;
  readonly onCancelQuestion: () => void;
  readonly sendError: string;
  readonly saveNote: string;
}

export function ChatComposer({
  projectId, selection, scopeSummary, modelSummary,
  models, modelRoute, onModelRouteChange, inheritedModel, modelsLoading, modelsError, modelsWarnings,
  onModelSelectionPendingChange,
  controlsExpanded, controlsId, onToggleControls, onFocusControls, showLatest, hasTurns, onJumpToLatest,
  question, onQuestionChange, onSubmit, sendDisabled, busy, queuedQuestion, onCancelQuestion, sendError, saveNote,
}: ChatComposerProps) {
  return (
    <form className='er-chat__composer' onSubmit={onSubmit}>
      <div className='er-chat__options' data-expanded={controlsExpanded} data-show-latest={showLatest && hasTurns}>
        <button className='er-button er-button--text er-chat__options-toggle' type='button'
          aria-label={'Sources and model: ' + scopeSummary + ' · ' + modelSummary}
          title={scopeSummary + ' · ' + modelSummary}
          aria-expanded={controlsExpanded} aria-controls={controlsId} onClick={onToggleControls}>
          <span className='er-chat__options-summary'>{scopeSummary} · {modelSummary}</span>
          <span aria-hidden='true'>{controlsExpanded ? 'Hide' : 'Change'}</span>
        </button>
        {showLatest && hasTurns ? <button className='er-button er-button--tonal er-chat__latest' type='button'
          aria-label='Jump to latest message' onClick={onJumpToLatest}>Latest <span aria-hidden='true'>↓</span></button> : null}
        <div className='er-chat__options-controls' id={controlsId} onFocusCapture={onFocusControls}>
          <p className='er-chat__hint er-chat__scope'>Sources: {selection.scopeMode === 'project_default' ? 'project default' : selection.scopeMode === 'empty' ? 'none' : selection.sourceIds.length + ' selected'}.{' '}
            <Link to={'/p/' + encodeURIComponent(projectId) + '/sources'}>Change sources</Link></p>
          <div className='er-chat__model'>
            <ModelPicker
              label='Model'
              choices={models}
              value={modelRoute}
              onChange={onModelRouteChange}
              defaultRoute={inheritedModel}
              loading={modelsLoading}
              error={modelsError}
              emptyLabel='Project default'
              compact
              warnings={modelsWarnings}
              onRoutePendingChange={onModelSelectionPendingChange}
            />
          </div>
        </div>
      </div>
      <label className='er-field er-chat__question-field' htmlFor='er-chat-q'>
        <span className='er-chat__asklabel'>Question</span>
        <textarea
          id='er-chat-q'
          value={question}
          onChange={onQuestionChange}
          rows={3}
          maxLength={4000}
          placeholder='Ask in Russian or English…'
        />
      </label>
      <button
        className='er-button er-button--primary'
        type='submit'
        disabled={sendDisabled}
      >
        {busy ? 'Sending…' : 'Send'}
      </button>
      {queuedQuestion !== null ? (
        <p className='er-chat__hint' role='status'>
          Next question: {queuedQuestion}{' '}
          <button className='er-button er-button--text' type='button' onClick={onCancelQuestion}>Cancel question</button>
        </p>
      ) : null}
      {sendError !== '' ? <p className='er-chat__error' role='alert'>{sendError}</p> : null}
      {saveNote !== '' ? <p className='er-chat__hint' role='status'>{saveNote}</p> : null}
    </form>
  );
}
