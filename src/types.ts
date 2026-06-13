export interface BlockingChain {
  engine_id: string;
  blocking_pid: number;
  blocked_pid: number;
  wait_duration_ms: number;
  wait_event: string;
  blocking_query: string | null;
  blocked_query: string | null;
  database_name: string | null;
  wait_type: string | null;
  status: string | null;
  host_name: string | null;
  program_name: string | null;
  login_time: string | null;
}