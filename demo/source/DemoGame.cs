using System;
using System.Drawing;
using System.Windows.Forms;

namespace ExampleQuestDemo
{
    internal static class DemoGame
    {
        [STAThread]
        private static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            Form form = new Form();
            form.Text = "Example Quest — Demo";
            form.ClientSize = new Size(960, 540);
            form.StartPosition = FormStartPosition.CenterScreen;
            form.BackColor = Color.FromArgb(16, 22, 31);
            form.ForeColor = Color.FromArgb(236, 232, 220);
            form.MinimumSize = new Size(640, 360);

            Label eyebrow = new Label();
            eyebrow.Text = "BPSteamFit · JUEGO DE DEMOSTRACIÓN";
            eyebrow.Font = new Font("Segoe UI", 9F, FontStyle.Bold);
            eyebrow.ForeColor = Color.FromArgb(234, 177, 74);
            eyebrow.AutoSize = true;
            eyebrow.Location = new Point(64, 72);
            form.Controls.Add(eyebrow);

            Label title = new Label();
            title.Text = "Example Quest";
            title.Font = new Font("Segoe UI", 46F, FontStyle.Bold);
            title.ForeColor = Color.FromArgb(246, 239, 225);
            title.AutoSize = true;
            title.Location = new Point(58, 104);
            form.Controls.Add(title);

            Label body = new Label();
            body.Text = "Este ejecutable es parte del paquete demo reproducible.\r\n" +
                "No contiene contenido comercial y no se conecta a Internet.";
            body.Font = new Font("Segoe UI", 12F);
            body.ForeColor = Color.FromArgb(174, 182, 195);
            body.AutoSize = false;
            body.Size = new Size(760, 70);
            body.Location = new Point(64, 220);
            form.Controls.Add(body);

            Button close = new Button();
            close.Text = "Cerrar demo";
            close.Size = new Size(170, 42);
            close.Location = new Point(64, 390);
            close.BackColor = Color.FromArgb(234, 177, 74);
            close.ForeColor = Color.FromArgb(20, 20, 20);
            close.FlatStyle = FlatStyle.Flat;
            close.FlatAppearance.BorderSize = 0;
            close.Click += delegate { form.Close(); };
            form.Controls.Add(close);
            form.AcceptButton = close;

            form.Shown += delegate
            {
                form.Focus();
                close.Focus();
            };

            Application.Run(form);
            return 0;
        }
    }
}
