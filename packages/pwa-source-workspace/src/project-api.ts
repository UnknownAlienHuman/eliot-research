// Compatibility facade: the owner client owns the wire/value implementation.
import { createProjectsApi } from '@eliotr/owner-api-client';
import { legacySourceHttp, legacySourceErrors, legacySourceEpoch } from './owner-client-ports.js';
export type { ProjectSummary, ProjectListView, ProjectMutationState, ProjectMutationView } from '@eliotr/owner-api-client';
const api = createProjectsApi(legacySourceHttp, legacySourceErrors, legacySourceEpoch);
export const { decodeProjectList, readProjects, createProject, updateProject } = api;
