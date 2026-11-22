@echo off
setlocal DisableDelayedExpansion
set "previewRoot=%LOCALAPPDATA%\faibots Preview"
set "profile=%previewRoot%\desktop"
if not exist "%profile%\faibots.db" if exist "%previewRoot%\478c5eb82773\faibots.db" set "profile=%previewRoot%\478c5eb82773"
start "" "%~dp0app\faibots.exe" "--user-data-dir=%profile%"
