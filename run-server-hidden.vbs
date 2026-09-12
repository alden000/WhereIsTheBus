' Launched by the "WhereIsTheBus Dev Server" Scheduled Task at logon.
' WshShell.Run with windowStyle=0 starts the process hidden (no console
' window) and bWaitOnReturn=False returns immediately, so this script (and
' the task that ran it) exits right away while npm run dev keeps running
' as its own independent process — it does not get torn down when the
' task "completes" or when Claude Code's own preview tooling stops.
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Resolved from this script's own location rather than hardcoded, so the
' same file works regardless of which drive/folder the repo is checked
' out to — the Scheduled Task just needs to point at this file.
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = scriptDir

nodeDir = WshShell.ExpandEnvironmentStrings("%ProgramFiles%\nodejs")
WshShell.Run "cmd /c set ""PATH=" & nodeDir & ";%PATH%"" && npm run dev >> server-log.txt 2>&1", 0, False
