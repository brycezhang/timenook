import type {
  BookContext,
  BookVersionView,
  BookAudioEntryView,
  BookCoverInput,
} from "../../../packages/contracts/src";
import { memberRequest } from "./project-api";
const base = (id: string) => `/projects/${encodeURIComponent(id)}/book`;
export const bookApi = {
  context: (id: string) => memberRequest<BookContext>(base(id)),
  version: (id: string, version: string) =>
    memberRequest<BookVersionView>(
      `${base(id)}/versions/${encodeURIComponent(version)}`,
    ),
  cover: (id: string, input: BookCoverInput) =>
    memberRequest<BookContext>(`${base(id)}/cover`, input, crypto.randomUUID()),
  generate: (id: string, expectedInputHash: string, key: string) =>
    memberRequest<BookVersionView>(
      `${base(id)}/versions`,
      { expectedInputHash },
      key,
    ),
  retry: (id: string, version: string, key: string) =>
    memberRequest<BookVersionView>(
      `${base(id)}/versions/${encodeURIComponent(version)}/retry`,
      {},
      key,
    ),
  audio: (entry: string) =>
    memberRequest<BookAudioEntryView>(
      `/book-audio/${encodeURIComponent(entry)}`,
    ),
};
