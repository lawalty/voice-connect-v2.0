import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('shared_files', Path(__file__).with_name('shared-files.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SharedFilesTests(unittest.TestCase):
    def test_incoming_images_documents_and_user_edits(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            destination = base / 'shared'
            inbound = base / 'inbound'
            for path in [destination / 'Images', destination / 'Documents', inbound]:
                path.mkdir(parents=True, exist_ok=True)
            database = base / 'state.sqlite'
            with sqlite3.connect(database) as db:
                db.execute('CREATE TABLE attachments(id TEXT,metadata TEXT,bytes BLOB)')
                db.execute('INSERT INTO attachments VALUES(?,?,?)', ('test-id', json.dumps({'mimeType':'image/png'}), b'vc image'))
            for name, data in [('incoming.pdf', b'document'), ('photo.jpg', b'native image')]:
                (inbound / name).write_bytes(data)
                os.utime(inbound / name, (0, 0))
            seen = set()
            uid = os.getuid()
            self.assertEqual(module.sync(database, inbound, destination, seen, uid), 3)
            self.assertEqual((destination / 'Documents/incoming.pdf').read_bytes(), b'document')
            self.assertEqual((destination / 'Images/photo.jpg').read_bytes(), b'native image')
            image = next((destination / 'Images').glob('image-*.png'))
            self.assertEqual(image.read_bytes(), b'vc image')
            image.write_bytes(b'user edit')
            self.assertEqual(module.sync(database, inbound, destination, seen, uid), 0)
            self.assertEqual(image.read_bytes(), b'user edit')
            image.unlink()
            self.assertEqual(module.sync(database, inbound, destination, seen, uid), 0)
            self.assertFalse(image.exists())

    def test_destination_links_and_traversal_cannot_overwrite_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            (base / 'Images').mkdir()
            victim = base / 'victim'
            victim.write_bytes(b'preserved')
            (base / 'Images/unsafe.png').symlink_to(victim)
            with self.assertRaises(ValueError):
                module.publish(base, 'Images', 'unsafe.png', b'replaced', os.getuid())
            with self.assertRaises(ValueError):
                module.publish(base, 'Images', '../victim', b'replaced', os.getuid())
            self.assertEqual(victim.read_bytes(), b'preserved')
            (base / 'Documents').symlink_to(base / 'Images', target_is_directory=True)
            with self.assertRaises(OSError):
                module.publish(base, 'Documents', 'new.pdf', b'new', os.getuid())


if __name__ == '__main__':
    unittest.main()
