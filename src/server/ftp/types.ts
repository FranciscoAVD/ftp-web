export type Commands =
  // Connection & Auth
  | "USER"
  | "PASS"
  | "QUIT"
  // Channel & Transfer Settings
  | "PASV"
  | "TYPE"
  | "STRU"
  | "MODE"
  // File Operations
  | "RETR"
  | "STOR"
  | "MKD"
  | "LIST"
  | "CWD"
  | "PWD"
  // Informational
  | "NOOP"
  | "HELP";
