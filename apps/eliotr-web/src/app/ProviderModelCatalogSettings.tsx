import { useDeferredValue, useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Status } from "@eliotr/ui";
import type { BoundWorkspaceApis } from "./runtime";
import type { PrivacyController, SessionContext } from "./privacy";
import { ModelCatalogFilter } from "./ModelCatalogFilter";
import { setAllModelCatalogEntriesVisible, setModelCatalogEntryVisibility, type ModelCatalogVisibility } from "../query/modelCatalog";
import { serviceModelCatalogPreferencesQueryOptions, serviceModelCatalogQueryOptions,
  updateGlobalModelCatalogPreferencesOnce } from "../query/globalModelSettings";

const copy = {
  en: {
    readingPreferences: "Reading saved model filters…",
    preferencesFailed: "Saved model filters could not be read.",
    save: "Save filters",
    saving: "Saving filters…",
    saved: "Model filters saved.",
    unknown: "The save outcome is unknown. Read the saved filters before trying again.",
    readSaved: "Read saved filters",
    readConfirmed: "Saved filters were read from the owner service.",
    readFailed: "Saved filters still could not be read.",
  },
  ru: {
    readingPreferences: "Читаем сохранённые фильтры моделей…",
    preferencesFailed: "Не удалось прочитать сохранённые фильтры моделей.",
    save: "Сохранить фильтры",
    saving: "Сохраняем фильтры…",
    saved: "Фильтры моделей сохранены.",
    unknown: "Результат сохранения неизвестен. Прочитайте сохранённые фильтры перед новой попыткой.",
    readSaved: "Прочитать сохранённые фильтры",
    readConfirmed: "Сохранённые фильтры прочитаны из сервиса владельца.",
    readFailed: "Не удалось прочитать сохранённые фильтры.",
  },
} as const;

type Draft = Readonly<{ search: string; visibility: ModelCatalogVisibility }>;
type Feedback = "idle" | "saving" | "saved" | "unknown" | "read" | "read-failed";

/** Owner preferences filter the public catalog; the settings API never grants provider access. */
export function ProviderModelCatalogSettings({ locale, apis, privacy, context, providerId,
  catalogProviderId = providerId }: {
  readonly locale: "en" | "ru";
  readonly apis: BoundWorkspaceApis;
  readonly privacy: PrivacyController;
  readonly context: SessionContext;
  readonly providerId: string;
  readonly catalogProviderId?: string;
}) {
  const text = copy[locale], api = apis.settings.models;
  const preferences = useQuery({ ...serviceModelCatalogPreferencesQueryOptions(api, privacy, context, providerId),
    enabled: privacy.isCurrent(context) });
  const [draft, setDraft] = useState<Draft>();
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [feedback, setFeedback] = useState<Feedback>("idle");
  const [page, setPage] = useState(1);
  const controller = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(false), running = useRef(false);
  const current = () => mounted.current && privacy.isCurrent(context);
  const saved = preferences.data;

  useEffect(() => {
    mounted.current = true;
    const close = () => {
      if (privacy.isCurrent(context)) return;
      controller.current?.abort(); controller.current = undefined; running.current = false;
      if (mounted.current) { setBusy(false); setFeedback("idle"); setDraft(undefined); setDirty(false); }
    };
    const unsubscribe = privacy.subscribe(close);
    close();
    return () => { mounted.current = false; unsubscribe(); controller.current?.abort(); controller.current = undefined; };
  }, [privacy, context]);

  useEffect(() => {
    if (!dirty && saved) setDraft({ search: saved.search, visibility: saved.visibility });
  }, [saved, dirty]);

  const search = draft?.search ?? saved?.search ?? "";
  const visibility = draft?.visibility ?? saved?.visibility;
  const deferredSearch = useDeferredValue(search);
  const catalog = useQuery({
    ...serviceModelCatalogQueryOptions(apis.connections.models, privacy, context,
      { providerId: catalogProviderId, search: deferredSearch, page }),
    enabled: preferences.isSuccess && privacy.isCurrent(context),
    placeholderData: previous => previous,
  });

  const updateDraft = (change: (previous: Draft) => Draft) => {
    if (!current() || saved === undefined) return;
    setDraft(previous => change(previous ?? { search: saved.search, visibility: saved.visibility }));
    setDirty(true); setFeedback("idle");
  };

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!current() || !dirty || !draft || running.current) return;
    running.current = true; setBusy(true); setFeedback("saving");
    const selected = new AbortController(); controller.current = selected;
    try {
      const result = await updateGlobalModelCatalogPreferencesOnce({ api,
        request: { protocol: "eliotr.service-model-provider-catalog-preferences.v1", provider_id: providerId,
          visibility: draft.visibility, search: draft.search.trim() }, generation: context.deploymentGeneration,
        signal: selected.signal, isCurrent: current });
      if (!current()) return;
      if (result) {
        setDraft({ search: result.search, visibility: result.visibility }); setDirty(false); setFeedback("saved");
        void preferences.refetch();
      } else setFeedback("unknown");
    } catch {
      if (current()) setFeedback("unknown");
    } finally {
      if (controller.current === selected) { controller.current = undefined; running.current = false; if (current()) setBusy(false); }
    }
  };

  const readSaved = async () => {
    if (!current() || running.current) return;
    running.current = true; setBusy(true);
    try {
      const result = await preferences.refetch();
      if (!current()) return;
      if (result.data) {
        setDraft({ search: result.data.search, visibility: result.data.visibility }); setDirty(false); setFeedback("read");
      } else setFeedback("read-failed");
    } catch { if (current()) setFeedback("read-failed"); }
    finally { running.current = false; if (current()) setBusy(false); }
  };

  return <section className="er-model-catalog-settings" aria-label={locale === "ru" ? "Фильтры моделей" : "Model visibility filters"}>
    {preferences.isPending && <Status announce>{text.readingPreferences}</Status>}
    {preferences.isError && <Status tone="error" announce>{text.preferencesFailed}</Status>}
    {preferences.data && <form onSubmit={event => { void save(event); }}>
      <ModelCatalogFilter locale={locale} catalog={catalog.data} loading={catalog.isFetching} failed={catalog.isError}
        search={search} visibility={visibility} busy={busy} onSearchChange={value => {
          setPage(1); updateDraft(previous => ({ ...previous, search: value }));
        }} onVisibilityChange={(modelId, visible) => updateDraft(previous => ({ ...previous,
          visibility: setModelCatalogEntryVisibility(previous.visibility, modelId, visible) }))}
        onAllVisibilityChange={visible => updateDraft(previous => ({ ...previous,
          visibility: setAllModelCatalogEntriesVisible(visible) }))}
        onPageChange={setPage} />
      <div className="er-model-catalog-settings__actions">
        <Button variant="primary" type="submit" disabled={!dirty || busy} loading={feedback === "saving"}>
          {feedback === "saving" ? text.saving : text.save}
        </Button>
        {(feedback === "unknown" || feedback === "read-failed") && <Button variant="text" type="button" disabled={busy}
          onClick={() => { void readSaved(); }}>{text.readSaved}</Button>}
      </div>
      {feedback === "saved" && <Status announce>{text.saved}</Status>}
      {feedback === "unknown" && <Status announce>{text.unknown}</Status>}
      {feedback === "read" && <Status announce>{text.readConfirmed}</Status>}
      {feedback === "read-failed" && <Status tone="error" announce>{text.readFailed}</Status>}
    </form>}
  </section>;
}
