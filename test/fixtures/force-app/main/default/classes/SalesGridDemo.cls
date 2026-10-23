/**
 * Example job for the Sales Grid Log Explorer. Runs a query, DML inside a
 * savepoint (rolled back, so nothing is saved), debug lines, and a caught
 * exception, so its debug log shows each kind of highlight.
 * Run: System.enqueueJob(new SalesGridDemo());
 */
public with sharing class SalesGridDemo implements Queueable {

    public class DemoException extends Exception {}

    public void execute(QueueableContext context) {
        System.debug('SalesGridDemo started');
        List<Account> accounts = [SELECT Id, Name FROM Account ORDER BY CreatedDate DESC LIMIT 5];
        System.debug('Accounts found: ' + accounts.size());

        Integer total = 0;
        for (Account acc : accounts) {
            total += acc.Name == null ? 0 : acc.Name.length();
        }
        System.debug('Total name length: ' + total);

        Savepoint sp = Database.setSavepoint();
        Account demo = new Account(Name = 'Sales Grid Demo');
        insert demo;
        demo.Name = 'Sales Grid Demo (renamed)';
        update demo;
        Database.rollback(sp);
        System.debug('Demo account rolled back');

        try {
            validate(null);
        } catch (DemoException e) {
            System.debug(LoggingLevel.ERROR, 'Caught: ' + e.getMessage());
        }
        System.debug('SalesGridDemo finished');
    }

    private static void validate(String value) {
        if (String.isBlank(value)) {
            throw new DemoException('Value is required, but it was blank');
        }
    }
}
