using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace ExampleQuestDemo
{
    internal static class DemoInstaller
    {
        private const int ExitOk = 0;
        private const int ExitCancelled = 5;
        private const int ExitFailure = 3;
        private const int ExitBadArguments = 2;
        private const int ExitReboot = 3010;

        [STAThread]
        private static int Main(string[] args)
        {
            try
            {
                Dictionary<string, string> options = ParseOptions(args);
                Log("Inicio. Argumentos: " + string.Join(" | ", args));

                if (options.ContainsKey("HELPER-CHILD"))
                {
                    string helperDir = options["HELPER-CHILD"];
                    Thread.Sleep(1600);
                    Directory.CreateDirectory(Path.Combine(helperDir, "data"));
                    File.WriteAllText(
                        Path.Combine(helperDir, "data", "ready.marker"),
                        "secondary process completed\r\n"
                    );
                    Log("Proceso secundario completado en " + helperDir);
                    return ExitOk;
                }

                string installDir = ResolveInstallDirectory(options);
                if (installDir == null)
                {
                    Log("Directorio de instalación inválido.");
                    return ExitBadArguments;
                }

                bool silent = options.ContainsKey("S") || options.ContainsKey("SILENT");
                if (!silent)
                {
                    return RunInteractive(installDir, options);
                }

                int slowness = ReadMilliseconds(options, "SLOW");
                if (slowness > 0)
                {
                    Thread.Sleep(slowness);
                }

                return Install(installDir, options);
            }
            catch (Exception exception)
            {
                Log("ERROR: " + exception);
                return ExitBadArguments;
            }
        }

        private static int Install(string installDir, Dictionary<string, string> options)
        {
            if (options.ContainsKey("FAIL"))
            {
                Log("Fallo simulado solicitado por /FAIL.");
                return ExitFailure;
            }

            string baseDir = Path.GetDirectoryName(Application.ExecutablePath);
            string gameSource = Path.Combine(baseDir, "game", "ExampleQuest.exe");
            string dataSource = Path.Combine(baseDir, "data", "payload.bin");
            if (!File.Exists(gameSource) || !File.Exists(dataSource))
            {
                Log("Faltan archivos de payload del instalador demo.");
                return ExitBadArguments;
            }

            Directory.CreateDirectory(Path.Combine(installDir, "bin"));
            Directory.CreateDirectory(Path.Combine(installDir, "data"));
            File.Copy(gameSource, Path.Combine(installDir, "bin", "ExampleQuest.exe"), true);
            File.Copy(dataSource, Path.Combine(installDir, "data", "level1.dat"), true);
            File.WriteAllText(
                Path.Combine(installDir, "install-info.txt"),
                "Example Quest (demo)\r\nInstalado por setup.exe sin automatización de clics.\r\n"
            );

            if (options.ContainsKey("HELPER"))
            {
                string executable = Application.ExecutablePath;
                ProcessStartInfo startInfo = new ProcessStartInfo();
                startInfo.FileName = executable;
                startInfo.Arguments = "/HELPER-CHILD=" + Quote(installDir);
                startInfo.UseShellExecute = false;
                startInfo.CreateNoWindow = true;
                Process.Start(startInfo);
                Log("Proceso secundario lanzado; setup terminará antes que él.");
            }

            Log("Instalación completada en " + installDir);
            if (options.ContainsKey("REBOOT"))
            {
                Log("Simulando reinicio requerido (3010).");
                return ExitReboot;
            }
            return ExitOk;
        }

        private static int RunInteractive(string installDir, Dictionary<string, string> options)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            Form form = new Form();
            form.Text = "Example Quest — Instalador demo";
            form.ClientSize = new Size(620, 270);
            form.StartPosition = FormStartPosition.CenterScreen;
            form.FormBorderStyle = FormBorderStyle.FixedDialog;
            form.MaximizeBox = false;
            form.MinimizeBox = false;
            form.BackColor = Color.FromArgb(24, 26, 31);
            form.ForeColor = Color.FromArgb(235, 232, 224);

            Label title = new Label();
            title.Text = "Example Quest";
            title.Font = new Font("Segoe UI", 22F, FontStyle.Bold);
            title.ForeColor = Color.FromArgb(242, 184, 75);
            title.AutoSize = true;
            title.Location = new Point(28, 24);
            form.Controls.Add(title);

            Label description = new Label();
            description.Text = "Instalador de demostración, sin contenido comercial.\n" +
                "Destino:\n" + installDir;
            description.Font = new Font("Segoe UI", 10F);
            description.AutoSize = false;
            description.Size = new Size(560, 90);
            description.Location = new Point(30, 78);
            form.Controls.Add(description);

            Button install = new Button();
            install.Text = "Instalar";
            install.Size = new Size(130, 36);
            install.Location = new Point(320, 205);
            install.DialogResult = DialogResult.None;
            form.Controls.Add(install);

            Button cancel = new Button();
            cancel.Text = "Cancelar";
            cancel.Size = new Size(130, 36);
            cancel.Location = new Point(460, 205);
            cancel.DialogResult = DialogResult.Cancel;
            form.Controls.Add(cancel);
            form.AcceptButton = install;
            form.CancelButton = cancel;

            int result = ExitCancelled;
            install.Click += delegate
            {
                install.Enabled = false;
                result = Install(installDir, options);
                if (result == ExitOk || result == ExitReboot)
                {
                    MessageBox.Show(
                        "Instalación de demostración completada.",
                        "Example Quest",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Information
                    );
                }
                else
                {
                    MessageBox.Show(
                        "La instalación de demostración falló con código " + result + ".",
                        "Example Quest",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error
                    );
                }
                form.Close();
            };

            form.ShowDialog();
            return result;
        }

        private static Dictionary<string, string> ParseOptions(string[] args)
        {
            Dictionary<string, string> options = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (string argument in args)
            {
                if (string.IsNullOrWhiteSpace(argument)) continue;
                string trimmed = argument.Trim();
                if (!trimmed.StartsWith("/"))
                {
                    options[trimmed] = "";
                    continue;
                }
                string withoutSlash = trimmed.Substring(1);
                int separator = withoutSlash.IndexOf('=');
                if (separator < 0)
                {
                    options[withoutSlash] = "";
                }
                else
                {
                    string key = withoutSlash.Substring(0, separator);
                    string value = withoutSlash.Substring(separator + 1).Trim();
                    if (value.Length >= 2 && value.StartsWith("\"") && value.EndsWith("\""))
                    {
                        value = value.Substring(1, value.Length - 2);
                    }
                    options[key] = value;
                }
            }
            return options;
        }

        private static string ResolveInstallDirectory(Dictionary<string, string> options)
        {
            string value;
            if (!options.TryGetValue("DIR", out value) || string.IsNullOrWhiteSpace(value))
            {
                value = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "ExampleQuestDemo"
                );
            }
            try
            {
                string full = Path.GetFullPath(value);
                string root = Path.GetPathRoot(full);
                if (string.IsNullOrEmpty(root) || full.Length <= root.Length) return null;
                return full;
            }
            catch
            {
                return null;
            }
        }

        private static int ReadMilliseconds(Dictionary<string, string> options, string key)
        {
            string value;
            if (!options.TryGetValue(key, out value) || string.IsNullOrWhiteSpace(value)) return 0;
            int milliseconds;
            if (!int.TryParse(value, out milliseconds)) return 0;
            if (milliseconds < 0) return 0;
            if (milliseconds > 300000) return 300000;
            return milliseconds;
        }

        private static string Quote(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        private static void Log(string message)
        {
            try
            {
                string line = DateTime.Now.ToString("s") + " " + message + Environment.NewLine;
                string path = Path.Combine(Path.GetTempPath(), "ExampleQuest-demo-setup.log");
                File.AppendAllText(path, line);
            }
            catch
            {
                // El fixture nunca debe fallar solo por no poder escribir un log.
            }
        }
    }
}
