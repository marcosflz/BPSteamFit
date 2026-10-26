using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

namespace BPSteamFitElevate
{
    internal static class ElevateHelper
    {
        private const uint SEE_MASK_NOCLOSEPROCESS = 0x00000040;
        private const uint SEE_MASK_NOASYNC = 0x00000100;
        private const int SW_SHOWNORMAL = 1;
        private const int ERROR_CANCELLED = 1223;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct SHELLEXECUTEINFO
        {
            public int cbSize;
            public uint fMask;
            public IntPtr hwnd;
            public string lpVerb;
            public string lpFile;
            public string lpParameters;
            public string lpDirectory;
            public int nShow;
            public IntPtr hInstApp;
            public IntPtr lpIDList;
            public string lpClass;
            public IntPtr hkeyClass;
            public uint dwHotKey;
            public IntPtr hIcon;
            public IntPtr hProcess;
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool ShellExecuteEx(ref SHELLEXECUTEINFO lpExecInfo);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);

        private const uint INFINITE = 0xFFFFFFFF;

        [STAThread]
        private static int Main(string[] args)
        {
            string requestPath = null;
            bool noElevate = false;
            for (int index = 0; index < args.Length; index++)
            {
                string argument = args[index];
                if (argument == "--no-elevate")
                {
                    noElevate = true;
                }
                else if (argument == "--request" && index + 1 < args.Length)
                {
                    requestPath = args[++index];
                }
            }

            if (string.IsNullOrEmpty(requestPath) || !File.Exists(requestPath))
            {
                return 2;
            }

            Dictionary<string, object> request;
            try
            {
                string json = File.ReadAllText(requestPath);
                request = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
            }
            catch
            {
                return 2;
            }

            string resultPath = GetString(request, "resultPath");
            string logPath = GetString(request, "logPath");
            try
            {
                return Execute(request, resultPath, logPath, noElevate);
            }
            catch (Exception exception)
            {
                Log(logPath, "ERROR: " + exception.Message);
                WriteResult(resultPath, new Dictionary<string, object>
                {
                    { "ok", false },
                    { "canceled", false },
                    { "error", exception.Message }
                });
                return 3;
            }
        }

        private static int Execute(
            Dictionary<string, object> request,
            string resultPath,
            string logPath,
            bool noElevate)
        {
            string executable = GetString(request, "executable");
            string parameters = GetString(request, "parameters") ?? string.Empty;
            string workingDirectory = GetString(request, "workingDirectory");
            string workRoot = GetString(request, "workRoot");
            string requestDirectory = Path.GetDirectoryName(Path.GetFullPath(resultPath ?? string.Empty));
            if (!IsFullyQualified(executable) || !File.Exists(executable))
            {
                return InvalidRequest(resultPath, logPath, "Ejecutable no válido.");
            }
            if (!IsFullyQualified(workingDirectory) || !Directory.Exists(workingDirectory))
            {
                return InvalidRequest(resultPath, logPath, "Directorio de trabajo no válido.");
            }
            if (!IsFullyQualified(resultPath) || !IsFullyQualified(logPath))
            {
                return InvalidRequest(resultPath, logPath, "Rutas de resultado/log no válidas.");
            }
            if (!IsFullyQualified(workRoot) || !Directory.Exists(workRoot))
            {
                return InvalidRequest(resultPath, logPath, "Raíz de trabajo no válida.");
            }
            if (!IsWithin(workRoot, executable) || !IsWithin(workRoot, workingDirectory))
            {
                return InvalidRequest(resultPath, logPath, "El setup o su directorio escapan de la raíz de trabajo.");
            }
            if (!IsWithin(requestDirectory, resultPath) || !IsWithin(requestDirectory, logPath))
            {
                return InvalidRequest(resultPath, logPath, "Resultado/log fuera del directorio de la solicitud.");
            }
            if (parameters.IndexOf('\0') >= 0 || parameters.IndexOf('\n') >= 0 || parameters.IndexOf('\r') >= 0)
            {
                return InvalidRequest(resultPath, logPath, "Argumentos con caracteres no válidos.");
            }

            Log(logPath, "Solicitud válida. Elevación: " + (noElevate ? "NO (prueba)" : "sí") + ". Ejecutable: " + executable);
            if (noElevate)
            {
                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = executable;
                startInfo.Arguments = parameters;
                startInfo.WorkingDirectory = workingDirectory;
                startInfo.UseShellExecute = false;
                startInfo.CreateNoWindow = true;
                using (Process process = Process.Start(startInfo))
                {
                    if (process == null)
                    {
                        return InvalidRequest(resultPath, logPath, "No se pudo iniciar el proceso.");
                    }
                    process.WaitForExit();
                    Dictionary<string, object> result = new Dictionary<string, object>();
                    result["ok"] = true;
                    result["canceled"] = false;
                    result["exitCode"] = process.ExitCode;
                    result["pid"] = process.Id;
                    WriteResult(resultPath, result);
                    Log(logPath, "Proceso terminado con código " + process.ExitCode + ".");
                    return 0;
                }
            }

            SHELLEXECUTEINFO info = new SHELLEXECUTEINFO();
            info.cbSize = Marshal.SizeOf(typeof(SHELLEXECUTEINFO));
            info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
            info.lpVerb = "runas";
            info.lpFile = executable;
            info.lpParameters = parameters;
            info.lpDirectory = workingDirectory;
            info.nShow = SW_SHOWNORMAL;

            bool launched = ShellExecuteEx(ref info);
            if (!launched || info.hProcess == IntPtr.Zero)
            {
                int errorCode = Marshal.GetLastWin32Error();
                bool canceled = errorCode == ERROR_CANCELLED;
                Dictionary<string, object> failed = new Dictionary<string, object>();
                failed["ok"] = false;
                failed["canceled"] = canceled;
                failed["errorCode"] = errorCode;
                failed["error"] = canceled
                    ? "El usuario canceló la elevación de UAC."
                    : new Win32Exception(errorCode).Message;
                WriteResult(resultPath, failed);
                Log(logPath, "ShellExecuteEx falló: " + errorCode + " (cancelado=" + canceled + ").");
                return 0;
            }

            try
            {
                WaitForSingleObject(info.hProcess, INFINITE);
                uint exitCode;
                GetExitCodeProcess(info.hProcess, out exitCode);
                Dictionary<string, object> result = new Dictionary<string, object>();
                result["ok"] = true;
                result["canceled"] = false;
                result["exitCode"] = (int)exitCode;
                WriteResult(resultPath, result);
                Log(logPath, "Proceso elevado terminado con código " + exitCode + ".");
            }
            finally
            {
                CloseHandle(info.hProcess);
            }
            return 0;
        }

        private static int InvalidRequest(string resultPath, string logPath, string message)
        {
            Log(logPath, "Solicitud inválida: " + message);
            WriteResult(resultPath, new Dictionary<string, object>
            {
                { "ok", false },
                { "canceled", false },
                { "error", message }
            });
            return 2;
        }

        private static string GetString(Dictionary<string, object> request, string key)
        {
            object value;
            if (request == null || !request.TryGetValue(key, out value) || value == null) return null;
            return value.ToString();
        }

        private static bool IsAbsolute(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return false;
            try
            {
                return Path.IsPathRooted(value);
            }
            catch
            {
                return false;
            }
        }

        private static bool IsFullyQualified(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return false;
            try
            {
                string full = Path.GetFullPath(value);
                return string.Equals(
                    Path.GetFullPath(full),
                    value,
                    StringComparison.OrdinalIgnoreCase
                );
            }
            catch
            {
                return false;
            }
        }

        private static bool IsWithin(string root, string candidate)
        {
            try
            {
                string normalizedRoot = Path.GetFullPath(root).TrimEnd('\\');
                string normalizedCandidate = Path.GetFullPath(candidate).TrimEnd('\\');
                if (string.Equals(normalizedRoot, normalizedCandidate, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
                return normalizedCandidate.StartsWith(
                    normalizedRoot + "\\",
                    StringComparison.OrdinalIgnoreCase
                );
            }
            catch
            {
                return false;
            }
        }

        private static void WriteResult(string path, Dictionary<string, object> result)
        {
            if (string.IsNullOrEmpty(path)) return;
            try
            {
                string directory = Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
                string json = new JavaScriptSerializer().Serialize(result);
                File.WriteAllText(path, json);
            }
            catch
            {
                // El motor detectará el resultado ausente.
            }
        }

        private static void Log(string path, string message)
        {
            if (string.IsNullOrEmpty(path)) return;
            try
            {
                string directory = Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
                File.AppendAllText(path, DateTime.Now.ToString("s") + " " + message + Environment.NewLine);
            }
            catch
            {
                // No debe impedir la operación.
            }
        }
    }
}
