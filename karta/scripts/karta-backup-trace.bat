@echo off
set MYSQL_BIN=C:\xampp\mysql\bin
set DB_HOST=127.0.0.1
set DB_PORT=3306
set DB_USER=root
set DB_NAME=karta_erp_v2
set BACKUP_DIR=C:\karta-v2-backups
set MAX_BACKUPS=5
set LOGFILE=%BACKUP_DIR%\backup.log
set TRACEFILE=%BACKUP_DIR%\trace.log

if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"

echo [TRACE] Script started > "%TRACEFILE%"
echo [TRACE] Config loaded >> "%TRACEFILE%"

for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HH-mm"') do set TIMESTAMP=%%I
set BACKUP_FILE=%BACKUP_DIR%\karta-v2-auto-%TIMESTAMP%.sql

echo [TRACE] TIMESTAMP=[%TIMESTAMP%] >> "%TRACEFILE%"
echo [TRACE] BACKUP_FILE=[%BACKUP_FILE%] >> "%TRACEFILE%"

"%MYSQL_BIN%\mysql.exe" --user=%DB_USER% --host=%DB_HOST% --port=%DB_PORT% -e "SELECT 1" %DB_NAME% >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [TRACE] FAILED: MySQL not running >> "%TRACEFILE%"
    exit /B 1
)
echo [TRACE] MySQL connected >> "%TRACEFILE%"

"%MYSQL_BIN%\mysqldump.exe" --user=%DB_USER% --host=%DB_HOST% --port=%DB_PORT% --single-transaction --routines --triggers --set-charset --default-character-set=utf8mb4 %DB_NAME% > "%BACKUP_FILE%" 2>>"%LOGFILE%"
echo [TRACE] mysqldump executed >> "%TRACEFILE%"

if not exist "%BACKUP_FILE%" (
    echo [TRACE] FAILED: file not created >> "%TRACEFILE%"
    exit /B 1
)

set FILESIZE=0
for %%A in ("%BACKUP_FILE%") do set FILESIZE=%%~zA
if %FILESIZE% EQU 0 (
    echo [TRACE] FAILED: file empty >> "%TRACEFILE%"
    del "%BACKUP_FILE%"
    exit /B 1
)

echo [TRACE] File OK size=%FILESIZE% >> "%TRACEFILE%"
echo [%TIMESTAMP%] SUCCESS: %FILESIZE% bytes >> "%LOGFILE%"
echo [TRACE] SUCCESS logged >> "%TRACEFILE%"

"%MYSQL_BIN%\mysql.exe" --user=%DB_USER% --host=%DB_HOST% --port=%DB_PORT% %DB_NAME% -e "INSERT INTO backup_metadata (id, last_backup_at, last_backup_by, backup_count, last_backup_size) VALUES (1, NOW(), 'auto', 1, %FILESIZE%) ON DUPLICATE KEY UPDATE last_backup_at = NOW(), last_backup_by = 'auto', backup_count = backup_count + 1, last_backup_size = VALUES(last_backup_size);" >nul 2>&1
echo [TRACE] Metadata updated >> "%TRACEFILE%"

set COUNT=0
for %%F in ("%BACKUP_DIR%\karta-v2-auto-*.sql") do set /A COUNT+=1
if %COUNT% GTR %MAX_BACKUPS% (
    for /f "skip=%MAX_BACKUPS% delims=" %%F in ('dir /B /O-D "%BACKUP_DIR%\karta-v2-auto-*.sql"') do del "%BACKUP_DIR%\%%F"
)
echo [TRACE] Retention done >> "%TRACEFILE%"

echo [TRACE] Script completed successfully >> "%TRACEFILE%"
exit /B 0
