public class AccountTriggerHandler {
    public static Integer depth = 0;
    public void run(List<Account> accounts) {
        depth++;
        try {
            AccountService.enrich(accounts);
        } catch (AccountValidation.ValidationException e) {
            System.debug('validation failed: ' + e.getMessage());
            recover(accounts);
        }
        if (depth < 2) {
            insert new Account(Name = 'Child');
        }
        System.debug('handler done');
    }
    private void recover(List<Account> accounts) {
        for (Account a : accounts) {
            a.Description = 'needs review';
        }
    }
}
