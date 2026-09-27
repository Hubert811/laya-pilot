import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    'workflow_excel', Path(__file__).resolve().parents[1] / 'lib/workflow_excel.py'
)
excel = importlib.util.module_from_spec(spec)
spec.loader.exec_module(excel)


class WorkbookTests(unittest.TestCase):
    def test_disabled_assertion_and_retry_report_roundtrip(self):
        with tempfile.TemporaryDirectory(prefix='laya-excel-') as directory:
            source = str(Path(directory) / '用例.xlsx')
            output = str(Path(directory) / '结果.xlsx')
            case = {
                'id': '001',
                'operation': 'form-validation',
                'steps': [
                    {'kind': 'assert-disabled', 'target': {'name': '保存\x1b[2m', 'role': 'button'}}
                ],
            }
            excel.write(
                {
                    'path': source,
                    'file': {
                        'schemaVersion': 1,
                        'generatedAt': 'test',
                        'moduleUrl': 'https://app.test/records',
                        'coverage': [],
                        'cases': [case],
                    },
                }
            )
            loaded = excel.read({'path': source})
            self.assertEqual(loaded['cases'][0], case)
            excel.results(
                {
                    'path': source,
                    'output': output,
                    'results': [
                        {
                            'id': '001',
                            'status': '失败',
                            'reason': '失败\x1b[31m',
                            'attempts': [
                                {
                                    'step': 'assert-disabled',
                                    'attempt': n,
                                    'status': '失败',
                                    'reason': '未禁用\x00',
                                }
                                for n in range(1, 4)
                            ],
                        }
                    ],
                }
            )
            book = excel.load_workbook(output)
            note = book['生成用例'].cell(2, 16).value
            self.assertIn('第3次', note)
            self.assertNotIn('\x1b', note)
            self.assertNotIn('\x00', note)
            self.assertEqual(book['生成用例'].cell(2, 11).value, 'fail')
            book.close()


if __name__ == '__main__':
    unittest.main()
