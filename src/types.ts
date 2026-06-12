export interface BlockingChain {
  blocking_pid: string | number;
  blocked_pid: string | number;
  wait_duration_ms: number;
  wait_event: string;
  blocking_query?: string;
  blocked_query?: string;
  database_name?: string;
  wait_type?: string;
  status?: string;
  login_time?: string; // ISO string
  host_name?: string;
  program_name?: string;
}
