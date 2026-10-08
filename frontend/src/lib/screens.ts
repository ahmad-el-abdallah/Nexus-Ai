/** What busy employees have on their desk monitors (`/api/employees/screens`). Real work only. */

import { request } from "./employees";

export interface Screen {
  /** chat | plan | breakdown | work | review | summary | report */
  kind: string;
  title: string;
  /** What they were asked, or the work they are reviewing. */
  brief: string;
  /** What they are producing, as it streams in (tail). */
  text: string;
  thinking: boolean;
  done: boolean;
  failed: boolean;
  started_at: string;
}

export const fetchScreens = () => request<Record<string, Screen>>("/api/employees/screens");
