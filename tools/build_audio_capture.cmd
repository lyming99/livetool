@echo off
setlocal
set "ROOT=%~dp0.."
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo Visual Studio C++ Build Tools are required to build the Media Foundation capture helper.
  exit /b 1
)
for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VS=%%i"
if not defined VS (
  echo No Visual Studio x64 C++ compiler found.
  exit /b 1
)
call "%VS%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b %errorlevel%
if not exist "%ROOT%\build\native-audio" mkdir "%ROOT%\build\native-audio"
cl /nologo /EHsc /std:c++17 /O2 /MT /W4 /DUNICODE /D_UNICODE /Fo"%ROOT%\build\native-audio\mf_capture.obj" /Fe"%ROOT%\build\native-audio\livetool-audio-capture.exe" "%ROOT%\native\mf_capture.cpp" /link /INCREMENTAL:NO mf.lib mfplat.lib mfreadwrite.lib mfuuid.lib ole32.lib
exit /b %errorlevel%
