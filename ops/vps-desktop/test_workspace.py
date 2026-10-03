import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('workspace',Path(__file__).with_name('cloud-workspace.py'))
workspace=importlib.util.module_from_spec(spec)
spec.loader.exec_module(workspace)


class WorkspaceTests(unittest.TestCase):
    def test_only_three_main_application_windows_are_managed(self):
        listing='''0x01 0 0 0 1440 810 host Chrome
0x02 0 0 0 1440 810 host Terminal
0x03 0 0 0 1440 810 host Shared files
0x04 0 200 100 400 300 host Save file
0x05 0 100 100 900 600 host DevTools - tab
0x06 0 0 0 100 100 host Other app'''
        def output(*command):
            if command[0]=='wmctrl':return listing
            kind='_NET_WM_WINDOW_TYPE_DIALOG' if command[2]=='0x04' else '_NET_WM_WINDOW_TYPE_NORMAL'
            cls={'0x02':'VCCloudTerminal','0x03':'Thunar','0x06':'Unrelated'}.get(command[2],'Google-chrome')
            return 'WM_CLASS(STRING) = "google-chrome (/profile with spaces)", "'+cls+'"\n'+kind
        with patch.object(workspace,'run',side_effect=output):
            self.assertEqual([w['app'] for w in workspace.windows()],['browser','terminal','files'])

    def test_repeated_app_switches_focus_existing_window_without_spawning(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(workspace,'CURRENT',Path(temporary)/'current'), patch.object(workspace,'windows',return_value=[{'id':'0x01','app':'browser'}]), patch.object(workspace,'run') as run, patch.object(workspace.subprocess,'Popen') as spawn:
                workspace.switch('browser')
                workspace.switch('browser')
                spawn.assert_not_called()
                self.assertEqual(workspace.CURRENT.read_text(),'browser')
                self.assertEqual(sum(call.args==('wmctrl','-ia','0x01') for call in run.call_args_list),2)

    def test_unknown_app_cannot_spawn_a_command(self):
        with patch.object(workspace.subprocess,'Popen') as spawn:
            with self.assertRaises(ValueError):workspace.switch('shell-command')
            spawn.assert_not_called()


if __name__=='__main__':unittest.main()
